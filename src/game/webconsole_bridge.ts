import type { MultiplayerEntry } from "./multiplayer_entry";
/** HTTP plugin transport; all mutations execute on the Lua update thread. */
import { NativeUi } from "./native_ui";
import { validateConfig } from "../core/config";
import type { RunSession } from "../core/run_session";
import type { NativeRuntime } from "./native_runtime";
import type { ShopWindow } from "./shop_window";
import { clockSeconds, getSingleton, refFs, rejson, loadWebconsole, type NativeWebconsole } from "./sdk";
import { PartySession } from "./party_session";
import { validateEquipmentConfig } from "./equipment_catalog";

interface Command {
  id?: string; bridgeId?: string; cmd?: string; armor?: string; index?: number;
  value?: boolean; itemId?: string; route?: string; config?: unknown;
  sceneToken?: string; dialogToken?: string; slot?: number; to?: string;
  configVersion?: number; questUnique?: number | null; waveToken?: number | null;
  sub?: string; playerId?: string; mockPlayers?: number;
  testLayer?: number; entryCode?: string;
  /** 评审二轮 #1：party 命令必须回传当前会话代数（state 发布），旧代拒绝。 */
  generation?: number;
}
type Outcome = Record<string, unknown>;

/** Transport IDs identify exact request bytes. A changed nested config, JSON
 * shape or field delimiter cannot be mistaken for a replay. Re-encoded requests
 * must use a fresh ID; business purchase dedupe is independent of this cache. */
function commandFingerprint(text:string, transport:NativeWebconsole):string {
  const hash=transport.steam_digest?.(text);
  if (typeof hash!=="string" || hash.length!==64) throw new Error("完整请求摘要不可用，请更新 webconsole DLL 并重启游戏");
  return hash;
}

export class WebConsoleBridge {
  readonly bridgeId: string;
  private readonly transport: NativeWebconsole;
  private readonly nativeUi: NativeUi;
  private pendingReceipt: Outcome | null = null;
  configVersion = 0;
  private frames = 0;
  private sampledAt = -1;
  private counter = 0;
  private results: Outcome[] = [];
  private closed = false;
  private effect: { id: string; kind: "kill" | "teleport"; unique: number; token: number;
    deadline: number; targets?: number[]; destination?: { x: number; y: number; z: number } } | null = null;
  private purchase: { id: string; version: number } | null = null;
  private configuration: {id:string;serial:number;receipt?:Outcome}|null=null;
  private configRevision=0;
  private externalConfigRevision=0;

  private readonly party: PartySession;

  /** 混合局权威人数：名册未锁定时 null（沿用原生人数）。 */
  partyRosterSize(): number | null { return this.party.rosterSize(); }

  constructor(private readonly session: RunSession, private readonly runtime: NativeRuntime,
    private readonly shop: ShopWindow, private readonly serviceStatus: () => unknown = () => null,
    party?: PartySession, private readonly multiplayerEntry?: MultiplayerEntry, private readonly previousRun: () => unknown = () => null,
    nativeUi?: NativeUi,private readonly editableConfig:()=>ReturnType<RunSession["configForEditing"]>=()=>this.session.configForEditing()) {
    this.party = party ?? new PartySession(this.session.configForEditing(), { layer: () => this.session.core.state.layer }, `run-${clockSeconds()}`);
    this.transport = loadWebconsole();
    this.bridgeId = `${this.transport.epoch()}-${clockSeconds()}-${Math.floor(Math.random() * 0xffffffff).toString(16)}`;
    const ownedQuestId = () => this.session.plan?.questId ?? this.session.core.config.quest.id;
    this.nativeUi = nativeUi ?? new NativeUi(this.bridgeId, ownedQuestId);
    if (nativeUi) nativeUi.rebind(this.bridgeId, ownedQuestId);
    this.writeResults({ id: "", status: "ready" });
  }

  newScriptSession(): NativeUi {
    this.closed = true;
    this.nativeUi.shutdown();
    this.transport.publish_state(rejson.dump_string({ ok: false, closed: true, bridgeId: this.bridgeId }, 0));
    return this.nativeUi;
  }

  tick(): void {
    if (this.closed) return;
    try {
      if (this.pendingReceipt && !this.writeResults(this.pendingReceipt)) return;
      const revision=this.runtime.multiplayerConfigRevision?.()??0;
      if(revision!==this.configRevision){this.configRevision=revision;this.configVersion++;}
      if(this.externalConfigRevision!==this.session.externalConfigRevision){this.externalConfigRevision=this.session.externalConfigRevision;this.configVersion++;}
      if(this.configuration){
        const outcome=this.runtime.multiplayerConfigResult?.(this.configuration.serial);
        if(outcome){
          const old=this.results.find(r=>r.id===this.configuration!.id);
          const receipt=Object.assign(old??this.configuration.receipt??{id:this.configuration.id},outcome,{configVersion:this.configVersion});
          if(!this.writeResults(receipt))return;
          this.configuration=null;
        }
      }
      this.pollEffect();
      const endedQuest = this.session.readingSnapshot?.quest;
      if (["Finished", "Fault"].includes(this.session.stage) && this.session.plan && endedQuest?.id === this.session.plan.questId && !endedQuest.playing)
        this.nativeUi.beginReturn(endedQuest.id, endedQuest.unique);
      this.nativeUi.tickReturn();
      const uiResult = this.nativeUi.poll();
      if (uiResult && uiResult.internal !== true) {
        const old = this.results.find(entry => entry.id === uiResult.id);
        if (old) Object.assign(old, uiResult);
        this.writeResults(old ?? uiResult);
      }
      if (this.purchase && this.shop.transactionVersion > this.purchase.version && this.shop.lastTransaction) {
        const result = this.results.find((entry) => entry.id === this.purchase!.id);
        if (result) {
          Object.assign(result, this.shop.lastTransaction);
          const saved = this.writeResults(result);
          if (!saved) return;
        }
        this.purchase = null;
      }
      if (++this.frames % 12 === 0) {
        // 评审 #6：去重记录有界（TTL 秒级），周期清理接线到 poll。
        this.party.prune();
        this.poll();
      }
      const now = clockSeconds();
      if (now !== this.sampledAt) { this.sampledAt = now; this.publish(); }
    } catch { /* Contention must not fault gameplay or flood the host log. */ }
  }

  private pollEffect(): void {
    const effect = this.effect;
    const reading = this.session.readingSnapshot;
    if (!effect || !reading) return;
    const result = this.results.find((r) => r.id === effect.id);
    if (!result) return;
    let status: string | null = null;
    let message = "";
    if (reading.quest?.unique !== effect.unique) { status = "uncertain"; message = "Quest changed before effect could be verified"; }
    else if (effect.kind === "teleport") {
      const target = effect.destination!;
      const pos = reading.localPlayerId != null ? reading.players.find(p => p.id === reading.localPlayerId)?.position
        : !reading.online ? reading.players[0]?.position : null;
      if (pos && (pos.x-target.x)**2 + (pos.y-target.y)**2 + (pos.z-target.z)**2 <= 25) {
        status = "applied"; message = "Position verified";
        result.position = {...pos}; result.verifiedAt = reading.time;
      }
    } else {
      const deaths = reading.enemies.filter((e) => e.dead || e.captured).map((e) => e.uid);
      if (effect.targets!.every((uid) => deaths.includes(uid) || reading.enemies.some((e) => e.uid === uid && (e.dead || e.captured)))) {
        status = "applied"; message = "Native deaths verified";
      }
    }
    if (!status && clockSeconds() >= effect.deadline) { status = "uncertain"; message = "Native effect not verified before deadline; do not resend blindly"; }
    if (status) {
      Object.assign(result, { status, message });
      if (this.writeResults(result)) this.effect = null;
    }
  }

  private poll(): void {
    // At most one mutation per poll; pending purchases settle before later commands.
    for (const text of this.transport.take_commands(1)) this.consume(text);
  }

  private consume(text: string): void {
    if (!text || text.length > 262144) return;
    const cmd = rejson.load_string(text) as Command | null;
    if (!cmd || typeof cmd.id !== "string" || cmd.id.length === 0 || cmd.id.length > 128) {
      return;
    }
    // 评审二轮 #2：传输 id 是唯一回执键。同 id 异载荷直接拒绝，
    // 不再允许"同 ID 多指纹"——否则 CLI 按 id 等回执会把上一条
    // 成功读成本次结果，端到端契约断裂。
    // 评审二轮 #1：party 业务身份在缓存之前校验——旧代命令连缓存
    // 都不允许命中（重放者拿不到上一代成功回执）。
    const staleBridge = cmd.bridgeId !== this.bridgeId;
    let fingerprint:string;
    try { fingerprint=commandFingerprint(text,this.transport); }
    catch(error) {this.writeResults({id:cmd.id,status:"rejected",message:String(error)});return;}
    const isParty = cmd.cmd === "party";
    if (isParty && (cmd.sub === "buy" || cmd.sub === "state")) {
      const gen = this.party.checkGeneration(cmd.generation);
      if (!gen.ok) {
        const result = { id: cmd.id, __fp: fingerprint, status: "rejected",
          message: gen.message ?? "party 会话身份校验失败" };
        this.writeResults(result);
        return;
      }
    }
    const old = staleBridge ? undefined : this.results.find((entry) => entry.id === cmd.id);
    let result: Outcome;
    if (old) {
      // 同 id 重放：载荷一致 → 回放旧回执（真重放保护）；不一致 → 拒绝。
      result = old.__fp === fingerprint
        ? old
        : { id: cmd.id, __fp: fingerprint, status: "rejected",
            message: "请求 id 与已处理命令载荷不一致（传输 id 必须唯一），已拒绝" };
    } else {
      try {
        if (staleBridge) throw new Error("连接会话已更换，请等待同步后重试");
        if (["choose", "buy", "killAll", "stop", "teleport", "submitConfig"].includes(cmd.cmd ?? "")) {
          if (cmd.questUnique !== this.session.readingSnapshot?.quest?.unique &&
            !(cmd.questUnique === null && !this.session.readingSnapshot?.quest))
            throw new Error("任务实例已变化，此操作已拒绝");
          if (cmd.waveToken !== this.session.plan?.token && !(cmd.waveToken === null && !this.session.plan))
            throw new Error("波次已变化，请查看当前波次后重新操作");
        }
        // 指纹已覆盖全部语义字段（评审二轮 #3），缓存条目不再需要 __fp 参与命中
        // 判断（同 id 异载荷已直接拒绝），但保留在回执里供对账。
        result = { id: cmd.id, __fp: fingerprint, ...this.execute(cmd) };
        if(this.configuration?.id===cmd.id)this.configuration.receipt=result;
      } catch (error) { result = { id: cmd.id, __fp: fingerprint, status: "rejected", message: String(error) }; }
      this.results.push(result);
      if (this.results.length > 30) this.results.shift();
    }
    this.writeResults(result);
  }

  private writeResults(last: Outcome): boolean {
    try {
      // CLI callers may immediately read state after a receipt, in the same
      // sampled second. Publish the resulting business state before acknowledging
      // every mutation, not only purchases. Retry publication without re-execution.
      if (last.status === "applied" || last.status === "queued") this.publish();
      const text = rejson.dump_string({ bridgeId: this.bridgeId,
        configVersion: this.configVersion, lastId: last.id, last, history: this.results }, 0);
      if (!text) throw new Error("结果序列化失败");
      this.transport.publish_results(text);
      this.pendingReceipt = null;
      return true;
    } catch { this.pendingReceipt = last; return false; }
  }

  private execute(cmd: Command): Outcome {
    const s = this.session;
    switch (cmd.cmd) {
      case "mpEntry": {
        if (!this.multiplayerEntry) throw new Error("当前构建没有联机入场实验模块。");
        if (cmd.sub === "choose") this.multiplayerEntry.choose(cmd.index!);
        else if (cmd.sub === "retrySync") this.multiplayerEntry.retrySync();
        else if (cmd.sub === "post") this.multiplayerEntry.post();
        else if (cmd.sub === "setArmor") this.multiplayerEntry.setArmor(cmd.armor!);
        else if (cmd.sub === "cancel") this.multiplayerEntry.cancel();
        else throw new Error("无效的联机入场命令。");
        return { status: "applied", message: "联机操作已提交；请查看全队同步和承接状态。" };
      }
      case "startup.acknowledge": case "title.advance": case "title.continue":
      case "save.load": case "dialog.close": case "result.receive": case "result.next": return this.nativeUi.request(cmd);
      case "returnToVillage": {
        const q = s.readingSnapshot?.quest;
        if (!["Finished", "Fault"].includes(s.stage) || !s.plan || !q || q.id !== s.plan.questId || q.playing)
          throw new Error("仅结束后的自定义任务可以继续原生结算");
        this.nativeUi.beginReturn(q.id, q.unique);
        return { status: "applied", message: "已接管原生结算，请等待返回村庄" };
      }
      case "getConfig": {
        const blocked=this.runtime.configurationRecoveryPending?.();if(blocked)throw new Error(blocked);
        return { status: "applied", message: "已读取游戏配置（含下一局规则）", config: this.editableConfig(),
        activeRules: { startPt: s.core.config.startPt, maxCarts: s.core.config.maxCarts,
          runtime: s.settings }, configVersion: this.configVersion };
      }
      case "submitConfig": {
        const blocked=this.runtime.configurationRecoveryPending?.();if(blocked)throw new Error(blocked);
        if (s.stage === "Preparing") throw new Error("已准备的个人装备和开局规则不能改变；请先取消准备");
        if(this.configuration||this.runtime.multiplayerConfigBusy?.())throw new Error("联机配置仍在同步，请等待完整回执");
        if (this.shop.busy) throw new Error("请等待商店交易完成后提交配置");
        if (cmd.configVersion !== this.configVersion) throw new Error("配置已被其他页面修改，请重新载入并合并");
        const cfg = validateConfig(cmd.config);
        const old = this.editableConfig();
        if (cfg.quest.id !== old.quest.id || cfg.quest.baseId !== old.quest.baseId || cfg.quest.mapNo !== old.quest.mapNo)
          throw new Error("任务身份只读，需要离线修改并重载脚本");
        if(s.multiplayerRole){
          const serial=this.runtime.submitMultiplayerConfig(cfg);this.configuration={id:cmd.id!,serial};
          return{status:"queued",serial,message:"等待全队校验、应用并保存；期间暂停选波和交易"};
        }
        s.validateConfigForSession(cfg);
        validateEquipmentConfig(cfg);
        // Preserve schema arrays: REF's encoder turns empty Lua tables into null.
        const text = rejson.dump_string(cfg, -1).split('"unlockChain":null').join('"unlockChain":[]')
          .split('"weak":null').join('"weak":[]');
        if (!text) throw new Error("配置序列化失败，未应用");
        refFs.write("mhw_rogue_config.json", text);
        if (refFs.read("mhw_rogue_config.json") !== text) throw new Error("配置保存验证失败，未应用");
        s.applyConfig(cfg); this.configVersion++;
        return { status: "applied", configVersion: this.configVersion,
          message: "已保存：商店下次交易、曲线与怪池下次生成选择时生效；开局装备、抽取池、增益数值与节奏下一局生效。当前波次保持原计划。" };
      }
      case "startRun": {
        if (cmd.testLayer !== undefined && (!Number.isInteger(cmd.testLayer) || cmd.testLayer < 1 ||
            !s.configForEditing().pools.some((pool) => cmd.testLayer! >= pool.from && cmd.testLayer! <= pool.to))) {
          throw new Error("测试层数不在已配置的怪物池范围内；未执行开局准备");
        }
        const r = s.start(cmd.armor ?? s.configForEditing().armorOptions[0] ?? "",
          false, cmd.testLayer);
        return { status: r.ok ? "applied" : "rejected", message: r.message };
      }
      case "choose": {
        if (this.shop.busy || !s.canChoose()) throw new Error("请完成集结和未决交易，再选择波次");
        if (!Number.isInteger(cmd.index)) throw new Error("请选择有效波次");
        const r = s.choose(cmd.index!);
        return { status: r.ok ? "applied" : "rejected", message: r.message };
      }
      case "buy": {
        if (this.purchase) throw new Error("上一笔交易回执尚未发布，请稍后再试");
        const r = this.shop.requestPurchase(cmd.itemId ?? "");
        if (r.ok) this.purchase = { id: cmd.id!, version: this.shop.transactionVersion };
        return { status: r.ok ? "queued" : "rejected", message: r.message };
      }
      case "setInvincible": {
        if (typeof cmd.value !== "boolean") throw new Error("value 必须是布尔值");
        if (this.runtime.testTools.invincible !== cmd.value) this.runtime.testTools.toggleGod();
        return { status: this.runtime.testTools.invincible === cmd.value ? "applied" : "rejected",
          message: this.runtime.testTools.message };
      }
      case "party": {
        if (this.effect) throw new Error("Another test effect is pending");
        const sub = String(cmd.sub ?? "");
        // 评审 #3：名册锁定在局生命周期——战斗/结算期禁止 create/reset，
        // 否则后续波次人数倍率会静默变化，违反"人数在开局名单锁定"。
        const rosterGate = ["Idle", "Finished", "Fault"].includes(s.stage);
        if ((sub === "create" || sub === "reset") && !rosterGate) {
          throw new Error(`名册锁定：当前阶段 ${s.stage} 不允许 ${sub}；请先 stop 或等回村`);
        }
        // 评审二轮 #1：buy/state 必须携带当前 generation；旧代/缺代拒绝。
        if (sub === "buy" || sub === "state") {
          const gen = this.party.checkGeneration(cmd.generation);
          if (!gen.ok) throw new Error(gen.message ?? "party 会话身份校验失败");
        }
        if (sub === "create") {
          // create 是获取会话身份的入口，允许无 generation（新会话首次建立）；
          // 名册已锁定时必须携带当前代才允许观察（create 本身重复会被拒）。
          const created = this.party.create("host", Number(cmd.mockPlayers ?? 1));
          if (!created.ok) throw new Error(created.message);
          return { status: "applied", message: created.message,
            businessParty: this.party.summary(), nativePlayers: s.readingSnapshot?.players.length ?? 0 };
        }
        if (sub === "buy") {
          if (!cmd.playerId || !cmd.itemId) throw new Error("party buy 需要 --as 与 --item");
          const result = this.party.buy(cmd.playerId, String(cmd.id ?? `party-${clockSeconds()}`), cmd.itemId, cmd.generation);
          return { status: result.ok ? "applied" : "rejected", message: result.message,
            playerPt: result.pt, owned: result.owned, duplicate: result.duplicate === true,
            businessParty: this.party.summary() };
        }
        if (sub === "state") {
          const view = cmd.playerId ? this.party.viewFor(String(cmd.playerId)) : this.party.summary();
          if (!view) throw new Error(`未知玩家 ${String(cmd.playerId)}`);
          return { status: "applied", businessParty: view, nativePlayers: s.readingSnapshot?.players.length ?? 0 };
        }
        if (sub === "reset") {
          this.party.reset();
          return { status: "applied", message: "Party session invalidated" };
        }
        throw new Error(`Unknown party subcommand ${sub}`);
      }
      case "killAll": {
        if (this.effect) throw new Error("Another test effect is pending");
        const reading = s.readingSnapshot;
        const targets = reading?.enemies.filter((e) => !e.dead && !e.captured).map((e) => e.uid) ?? [];
        if (!reading?.quest?.playing || targets.length === 0) throw new Error("No alive bosses in the active quest");
        this.effect = { id: cmd.id!, kind: "kill", unique: reading.quest.unique, token: s.plan!.token,
          deadline: clockSeconds() + 12, targets };
        this.runtime.testTools.requestKill();
        return { status: "queued", message: "Waiting for native death evidence", targets };
      }
      case "teleport": {
        if (!s.plan || !s.readingSnapshot?.quest?.playing || (s.readingSnapshot.online &&
            !this.runtime.multiplayerValid?.() && !this.runtime.allowEntryHostTest?.(s.readingSnapshot)) ||
          !["Combat", "Carve", "Returning", "Selecting"].includes(s.stage)) throw new Error("TP requires an owned active arena run");
        if (this.effect) throw new Error("Another test effect is pending");
        if (cmd.to !== "origin" && cmd.to !== "monster") throw new Error("Use origin or monster");
        const target = cmd.to === "origin" ? s.campSnapshot
          : cmd.to === "monster" ? this.runtime.nearestAliveMonsterPosition() : null;
        if (!target) throw new Error(cmd.to === "monster" ? "No alive boss position in the active wave" : "Origin position unavailable");
        const destination = { x: target.x + (cmd.to === "monster" ? 4 : 0), y: target.y, z: target.z };
        this.runtime.teleportPlayer(destination);
        this.effect = { id: cmd.id!, kind: "teleport", unique: s.readingSnapshot.quest.unique,
          token: s.plan.token, deadline: clockSeconds() + 12, destination };
        return { status: "queued", target: destination, to: cmd.to,
          questUnique: s.readingSnapshot.quest.unique, message: "Position request submitted; verify player position on a later frame" };
      }
      case "retryPost": {
        const r = s.retryPost(); return { status: r.ok ? "applied" : "rejected", message: r.message };
      }
      case "stop":
        if (s.stage === "Preparing" && this.multiplayerEntry) this.multiplayerEntry.cancel();
        else s.stop();
        return { status: "applied", message: "已停止本局" };
      case "setRoute": {
        if (!["Idle", "Finished", "Fault"].includes(s.stage)) throw new Error("路线只能在开局前切换");
        if (cmd.route !== "inPlace" && cmd.route !== "reentry") throw new Error("无效路线");
        s.setRunRoute(cmd.route);
        return { status: "applied", message: cmd.route };
      }
      default: throw new Error(`未知命令：${cmd.cmd ?? ""}`);
    }
  }

  /**
   * Native UI/viewpoint observation for the CLI and the console. Every field is
   * read from documented StateObject sources; unknown stays null. This is a
   * viewpoint sensor, not a window classifier: it cannot see title, save select or
   * dialogs, so the CLI reports scene=unknown with the evidence that would raise it.
   */
  private uiSection(): Record<string, unknown> {
    const r = this.session.readingSnapshot;
    // stage 是安装版 QuestManager 的状态枚举：失败/成功但未回村时，任务对象仍注册。
    // 这不是"另一局正在进行"，RuntimeReading.staleQuest 与这里用同一判据。
    const stageValue = r?.quest?.status ?? null;
    const staleQuest = r?.quest != null && (stageValue === "failed" || stageValue === "success") && !r.quest.playing;
    // 安装版 StageManager 无 get_MapNo（sdk-dump 只有 warp/area/time 成员），不猜访问器。
    const mapNo: number | null = null;
    const players = r?.players ?? [];
    const position = players[0]?.position ?? null;
    const inQuest = r?.quest !== null && r?.quest !== undefined;
    const native = this.nativeUi.observe();
    const scene = native.scene !== "unknown" ? native.scene : inQuest
      ? (r?.quest?.playing ? "quest" : "quest_ready")
      : (r?.canPost && players.length > 0 ? "village" : "unknown");
    return {
      ...native,
      scene,
      // Native UI revision is bound to this Lua bridge generation.
      sceneToken: native.sceneToken,
      mapNo,
      loading: native.loading ?? (native.scene === "unknown" && position === null ? null : false),
      busy: this.shop.busy || native.busy,
      questStatus: r?.quest?.status ?? null,
      online: r?.online ?? false,
      canPost: r?.canPost ?? false,
      allowedActions: native.dialogs.length > 0 ? native.allowedActions : [
        ...native.allowedActions,
        ...(["Idle", "Finished", "Fault"].includes(this.session.stage) && r?.canPost &&
          (!inQuest || staleQuest) ? ["run.start"] : []),
        ...(this.session.canShop() && !this.shop.busy ? ["run.choose", "shop.buy"] : []),
        ...(["AwaitQuest", "Fault"].includes(this.session.stage) ? ["run.retry"] : []),
        ...(inQuest && r?.quest?.playing ? ["test.killAll"] : []),
      ],
      evidence: [
        ...native.evidence,
        { source: "snow.QuestManager.isActiveQuest", value: inQuest },
        { source: "snow.stage.StageManager", value: "no verified map accessor in the installed SDK" },
        { source: "snow.gui.GuiManager.IsCanInvokeQuestBoard", value: r?.canPost ?? null },
        { source: "snow.player.PlayerManager.PlayerList", value: players.length },
      ],
      dialogsKnown: false,
      note: "Native title/save/menu observation; unclassified dialogs remain unsupported.",
    };
  }

  private publish(): void {
    const s = this.session, core = s.core, r = s.readingSnapshot;
    const listing = this.shop.catalogue();
    const next = s.configForEditing();
    const idle = ["Idle", "Finished", "Fault"].includes(s.stage);
    const entryHostTest = !!r && !!this.runtime.allowEntryHostTest?.(r);
    const activeSolo = !!r?.quest?.playing && (!r?.online || entryHostTest || this.runtime.multiplayerValid?.()) && !!s.plan;
    const ready = this.runtime.ready?.() ?? false;
    const canStart = idle && ready && !r?.online && !!r?.canPost && (!r?.quest || !!r.staleQuest) && !s.startupStatus.restorePending;
    const alive = r?.enemies.some((enemy) => !enemy.dead && !enemy.captured) ?? false;
    // Wire protocol for CLI/UI compatibility checks. A typo cannot be caught by the
    // transpiler, so the native tests read this literal back from the Lua module.
    this.transport.publish_state(rejson.dump_string({ ok: true, protocol: 4, bridgeId: this.bridgeId,
      counter: ++this.counter, sampledAt: r?.time ?? null, publishedAt: clockSeconds(),
      multiplayerEntry: this.multiplayerEntry?.snapshot() ?? null,
      multiplayerRun: this.runtime.multiplayerState?.() ?? null,
      configVersion: this.configVersion, sessionStage: s.stage, corePhase: core.state.phase,
      questId: r?.quest?.id ?? null, questUnique: r?.quest?.unique ?? null,
      quest: r?.quest ?? null, online: r?.online ?? false, route: s.route,
      layer: core.state.layer, pt: core.state.wallet.pt, cartsLeft: core.state.cartsLeft,
      nativeDeaths: r?.deaths ?? null, maxCarts: core.config.maxCarts, armor: core.state.armor, armorOptions: s.configForEditing().armorOptions,
      nativeOnline: r?.online ?? null, businessParty: this.party.active ? this.party.summary() : null,
      entryHostTest,
      // 评审二轮 #1：party 会话身份直接发布在顶层，CLI 无需解析 businessParty。
      partyGeneration: this.party.active ? this.party.currentGeneration() : null,
      previousRun: this.previousRun(), runSummary: ["Finished","Fault"].includes(s.stage) ? s.runSummary() : null,
      supplyLoot:s.supplyLoot, killedUltimates: core.state.killedUltimates,
      invincible: this.runtime.testTools.invincible,
      activeWave: core.state.activeWave?.label ?? null, preparation: s.preparation(),
      enemies: r?.enemies ?? [], choices: s.stage === "Selecting" ? core.state.currentChoices : [],
      shop: listing.categories, shopAvailable: listing.available, shopReason: listing.reason,
      shopBusy: this.shop.busy, shopNotice: this.shop.notice, message: s.message,
      runtimeStatus: this.runtime.status(),
      ui: this.uiSection(),
      control: { ready, configRecovery:this.runtime.configurationRecoveryPending?.()??null,nextRoute: s.nextRoute, configuredRoute: next.runtime?.route ?? s.settings.route,
        startReason: canStart ? null : !idle ? "当前一局尚未结束" : s.startupStatus.restorePending ? s.startupMessage ?? "请先回村，等待原装备与背包恢复完成"
          : !ready ? this.runtime.configurationRecoveryPending?.()??"等待任务安装和原生接口就绪" : r?.online ? "当前仅支持单人开局" : "请在村庄、未接任务时开局",
        startup: s.startupStatus, startupRules: next.startupRules ?? null, armorSets: next.armorSets ?? {},
        testLayers: next.pools.map((pool) => pool.from),
        activeWave: s.plan ? { ...s.plan.wave, token: s.plan.token, monsterIds: s.plan.monsterIds, layer: s.plan.layer } : null,
        testMessage: this.runtime.testTools.message, effectPending: this.effect !== null },
      services: { buffs: this.serviceStatus(), lastTransaction: this.shop.lastTransaction,
        cartRestoreUsed: core.state.cartRestoreUsed, purchases: core.state.wallet.purchaseLog },
      capabilities: { start: canStart, route: idle, retry: ["AwaitQuest", "Fault"].includes(s.stage),
        invincible: true, kill: activeSolo && alive && !this.effect,
        teleportMonster: activeSolo && alive && !this.effect, testLayer: canStart,
        teleport: activeSolo && !!s.campSnapshot && !this.effect,
        choose: s.canChoose() && !this.shop.busy, stop: !["Idle", "Finished"].includes(s.stage) },
    }, 0));
  }
}
