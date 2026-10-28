/** HTTP plugin transport; all mutations execute on the Lua update thread. */
import { validateConfig } from "../core/config";
import type { RunSession } from "../core/run_session";
import type { NativeRuntime } from "./native_runtime";
import type { ShopWindow } from "./shop_window";
import { clockSeconds, refFs, rejson } from "./sdk";

interface Command {
  id?: string; bridgeId?: string; cmd?: string; armor?: string; index?: number;
  value?: boolean; itemId?: string; route?: string; config?: unknown;
  configVersion?: number; questUnique?: number | null; waveToken?: number | null;
}
type Outcome = Record<string, unknown>;

export class WebConsoleBridge {
  readonly bridgeId = `${clockSeconds()}-${Math.floor(Math.random() * 0xffffffff).toString(16)}`;
  configVersion = 0;
  private frames = 0;
  private sampledAt = -1;
  private counter = 0;
  private results: Outcome[] = [];
  private closed = false;
  private purchase: { id: string; version: number } | null = null;

  constructor(private readonly session: RunSession, private readonly runtime: NativeRuntime,
    private readonly shop: ShopWindow) {}

  newScriptSession(): void {
    this.closed = true;
    rejson.dump_file("webconsole_state.json", { ok: false, closed: true, bridgeId: this.bridgeId }, 0);
  }

  tick(): void {
    if (this.closed) return;
    try {
      if (this.purchase && this.shop.transactionVersion > this.purchase.version && this.shop.lastTransaction) {
        const result = this.results.find((entry) => entry.id === this.purchase!.id);
        if (result) {
          Object.assign(result, this.shop.lastTransaction);
          const saved = this.writeResults(result);
          if (!saved) return;
        }
        this.purchase = null;
      }
      if (++this.frames % 12 === 0) this.poll();
      const now = clockSeconds();
      if (now !== this.sampledAt) { this.sampledAt = now; this.publish(); }
    } catch { /* Contention must not fault gameplay or flood the host log. */ }
  }

  private poll(): void {
    const text = refFs.read("webconsole_cmd.json");
    if (!text || text.length > 262144) return;
    const cmd = rejson.load_string(text) as Command | null;
    if (!cmd || typeof cmd.id !== "string" || cmd.id.length === 0 || cmd.id.length > 128) {
      if (text !== "{}" && text !== "null") rejson.dump_file("webconsole_cmd.json", {}, 0);
      return;
    }
    const old = this.results.find((entry) => entry.id === cmd.id);
    let result: Outcome;
    if (old) result = old;
    else {
      try {
        if (cmd.bridgeId !== this.bridgeId) throw new Error("连接会话已更换，请等待同步后重试");
        if (["choose", "buy", "killAll", "stop"].includes(cmd.cmd ?? "")) {
          if (cmd.questUnique !== this.session.readingSnapshot?.quest?.unique &&
            !(cmd.questUnique === null && !this.session.readingSnapshot?.quest))
            throw new Error("任务实例已变化，此操作已拒绝");
          if (cmd.waveToken !== this.session.plan?.token && !(cmd.waveToken === null && !this.session.plan))
            throw new Error("波次已变化，请查看当前波次后重新操作");
        }
        result = { id: cmd.id, ...this.execute(cmd) };
      } catch (error) { result = { id: cmd.id, status: "rejected", message: String(error) }; }
      this.results.push(result);
      if (this.results.length > 30) this.results.shift();
    }
    if (this.writeResults(result))
      rejson.dump_file("webconsole_cmd.json", {}, 0);
  }

  private writeResults(last: Outcome): boolean {
    return rejson.dump_file("webconsole_results.json", { bridgeId: this.bridgeId,
      configVersion: this.configVersion, lastId: last.id, last,
      history: this.results }, 0);
  }

  private execute(cmd: Command): Outcome {
    const s = this.session;
    switch (cmd.cmd) {
      case "getConfig": return { status: "applied", message: "已读取游戏配置（含下一局规则）", config: s.configForEditing(),
        activeRules: { startPt: s.core.config.startPt, maxCarts: s.core.config.maxCarts,
          runtime: s.settings }, configVersion: this.configVersion };
      case "submitConfig": {
        if (this.shop.busy) throw new Error("请等待商店交易完成后提交配置");
        if (cmd.configVersion !== this.configVersion) throw new Error("配置已被其他页面修改，请重新载入并合并");
        const cfg = validateConfig(cmd.config);
        const old = s.configForEditing();
        if (cfg.quest.id !== old.quest.id || cfg.quest.baseId !== old.quest.baseId || cfg.quest.mapNo !== old.quest.mapNo)
          throw new Error("任务身份只读，需要离线修改并重载脚本");
        s.validateConfigForSession(cfg);
        // Preserve schema arrays: REF's encoder turns empty Lua tables into null.
        const text = rejson.dump_string(cfg, -1).split('"unlockChain":null').join('"unlockChain":[]')
          .split('"weak":null').join('"weak":[]');
        if (!text) throw new Error("配置序列化失败，未应用");
        refFs.write("mhw_rogue_config.json", text);
        if (refFs.read("mhw_rogue_config.json") !== text) throw new Error("配置保存验证失败，未应用");
        s.applyConfig(cfg); this.configVersion++;
        return { status: "applied", configVersion: this.configVersion,
          message: "已保存：商店下次交易、曲线与怪池下次生成选择时生效；开局规则和节奏下一局生效。当前波次保持原计划。" };
      }
      case "startRun": {
        const r = s.start(cmd.armor ?? s.configForEditing().armorOptions[0] ?? "");
        return { status: r.ok ? "applied" : "rejected", message: r.message };
      }
      case "choose": {
        if (this.shop.busy || !s.canShop()) throw new Error("请完成集结和未决交易，再选择波次");
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
      case "killAll": this.runtime.testTools.requestKill(); return { status: "queued", message: "等待原生怪物更新执行击杀" };
      case "retryPost": {
        const r = s.retryPost(); return { status: r.ok ? "applied" : "rejected", message: r.message };
      }
      case "stop": s.stop(); return { status: "applied", message: "已停止本局" };
      case "setRoute": {
        if (!["Idle", "Finished", "Fault"].includes(s.stage)) throw new Error("路线只能在开局前切换");
        if (cmd.route !== "inPlace" && cmd.route !== "reentry") throw new Error("无效路线");
        s.settings.route = cmd.route; s.route = cmd.route;
        return { status: "applied", message: cmd.route };
      }
      default: throw new Error(`未知命令：${cmd.cmd ?? ""}`);
    }
  }

  private publish(): void {
    const s = this.session, core = s.core, r = s.readingSnapshot;
    const listing = this.shop.catalogue();
    rejson.dump_file("webconsole_state.json", { ok: true, protocol: 3, bridgeId: this.bridgeId,
      counter: ++this.counter, sampledAt: r?.time ?? null, publishedAt: clockSeconds(),
      configVersion: this.configVersion, sessionStage: s.stage, corePhase: core.state.phase,
      questId: r?.quest?.id ?? null, questUnique: r?.quest?.unique ?? null,
      quest: r?.quest ?? null, online: r?.online ?? false, route: s.route,
      layer: core.state.layer, pt: core.state.wallet.pt, cartsLeft: core.state.cartsLeft,
      maxCarts: core.config.maxCarts, armor: core.state.armor, armorOptions: s.configForEditing().armorOptions,
      invincible: this.runtime.testTools.invincible,
      activeWave: core.state.activeWave?.label ?? null, preparation: s.preparation(),
      enemies: r?.enemies ?? [], choices: s.stage === "Selecting" ? core.state.currentChoices : [],
      shop: listing.categories, shopAvailable: listing.available, shopReason: listing.reason,
      shopBusy: this.shop.busy, shopNotice: this.shop.notice, message: s.message,
      runtimeStatus: this.runtime.status(),
      capabilities: { start: ["Idle", "Finished", "Fault"].includes(s.stage) && !!r?.canPost && !r?.quest,
        choose: s.canShop() && !this.shop.busy, stop: !["Idle", "Finished"].includes(s.stage) },
    }, 0);
  }
}
