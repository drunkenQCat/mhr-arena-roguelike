import { InplaceWaves } from "./inplace_waves";
import { TestTools } from "./test_tools";
import { entryHostTestScope } from "./entry_host_scope";
import type { RogueConfig } from "../core/config";
import { DEFAULT_RUNTIME, type QuestPlan } from "../core/quest_plan";
import type { DeathReading, EnemyReading, PlayerReading, RuntimeReading, SessionPort } from "../core/run_session";
import { QuestInstaller } from "./quest_installer";
import { QuestTransport } from "./quest_transport";
import { equipStartupSet, restoreStartup, reapplyStartup, type EquipWearPort } from "./equip_wear";
import { beginPouchIsolation, endPouchIsolation } from "./pouch_backup";
import { DEFAULT_STARTUP_RULES } from "../core/config";
import { GachaService } from "./gacha";
import { snow_QuestManager_Status } from "./gen/enums/snow_QuestManager_Status";
import { snow_quest_EmEndType } from "./gen/enums/snow_quest_EmEndType";
import { snow_quest_FailReason } from "./gen/enums/snow_quest_FailReason";
import { snow_enemy_EnemyDef_VitalCategory } from "./gen/enums/snow_enemy_EnemyDef_VitalCategory";
import { snow_enemy_EnemyDef_NandoGetType } from "./gen/enums/snow_enemy_EnemyDef_NandoGetType";
import {
  clockSeconds, findTypeDefinition, floatToPtr, getSingleton, hookMethod, PRE_HOOK,
  questManager, reframework, rejson, relog, toFloat, toInt64, toManagedObject, toPtr,
  type REManagedArray, type REManagedObject,
} from "./sdk";

function callNative(object: REManagedObject, name: string, ...args: unknown[]): unknown {
  try { return object.call(name, ...args); }
  catch (error) { throw new Error(`${name}: ${String(error)}`); }
}

interface Diagnostic { time: number; event: string; detail: unknown }

export class NativeRuntime implements SessionPort {
  readonly transport: QuestTransport;
  readonly testTools = new TestTools((event, detail) => this.report(event, detail), () => this.entryHostTest && entryHostTestScope());
  /** Test-only seam: lets the CLI verify the started-run flow without native menus. */
  readonly questTransport: QuestTransport;
  private readonly inplace = new InplaceWaves((event, detail) => this.report(event, detail),
    (plan, slot, type, id) => this.installer.prepareInplaceSlot(plan, slot, type, id), () => this.entryHostTest && entryHostTestScope());
  private activePlan: QuestPlan | null = null;
  private holdClear = false;
  private hooks = false;
  private bootError: string | null = null;
  private deaths: DeathReading[] = [];
  private events: Diagnostic[] = [];
  private rateKeys: string[] = [];
  private rateEvidence: unknown[] = [];
  /** 离线队友调研 §6C：混合局权威人数来源（PartySession.rosterSize）。 */
  private partySizeSource: (() => number | null) | null = null;

  constructor(private readonly cfg: RogueConfig, readonly installer: QuestInstaller,
    private readonly gacha?: GachaService, private readonly entryHostTest = false) {
    this.transport = new QuestTransport(() => installer.getQuest(),
      (cfg.runtime ?? DEFAULT_RUNTIME).postTimeoutSeconds);
    this.questTransport = this.transport;
  }

  /** main.ts 在 PartySession 建立后接线；null=沿用原生人数。 */
  setPartySizeSource(source: (() => number | null) | null): void { this.partySizeSource = source; }

  partySizePort(): number | null { return this.partySize?.() ?? null; }

  tick(): void {
    this.installer.tick();
    if (!this.hooks && !this.bootError && this.installer.isInstalled()) {
      try { this.installHooks(); }
      catch (error) { this.bootError = String(error); this.report("hook-install-error", this.bootError); }
    }
    this.transport.tick();
    this.inplace.tick(clockSeconds());
    this.testTools.tick();
    const rates = this.rateEvidence;
    this.rateEvidence = [];
    for (const evidence of rates) this.report("rate-applied", evidence);
  }
  ready(): boolean { return this.installer.isInstalled() && this.hooks && this.bootError === null; }
  status(): string { return this.bootError ?? `${this.installer.getStatus()} / counter: ${this.transport.getStatus()} / ${this.inplace.status}`; }
  publish(plan: QuestPlan, inPlace: boolean): void {
    if (inPlace) this.inplace.prepare(plan);
    else { this.inplace.cancel(); this.installer.publish(plan, false); }
  }
  policy(plan: QuestPlan | null, holdClear: boolean): void {
    if (this.activePlan?.token !== plan?.token) this.rateKeys = [];
    this.activePlan = plan; this.holdClear = holdClear;
    if (!plan || !holdClear) this.inplace.cancel();
  }
  post(questId: number): void {
    const ready = reapplyStartup();
    if (!ready.ok) throw new Error(ready.reason);
    this.transport.request(questId);
  }
  cancelPost(): void { this.transport.cancel(); }
  retarget(questId: number): void { this.transport.retarget(questId); }
  waitingForSpawnCapacity(): boolean { return this.inplace.waitingForCapacity; }
  postingError(): string | null { return this.transport.getError(); }
  takeDeaths(): DeathReading[] { const events = this.deaths; this.deaths = []; return events; }
  /** SessionPort.partySize：返回混合局名单人数；未锁定时 null=沿用原生人数。 */
  partySize(): number | null { return this.partySizeSource?.() ?? null; }
  allowEntryHostTest(reading: RuntimeReading): boolean {
    return this.entryHostTest && reading.quest?.id === 900103 && reading.players.length <= 1 && entryHostTestScope();
  }
  /**
   * Test-only teleport request: drives the game's own warp flow (fade out, move,
   * fade in over a few seconds); the caller verifies the position on later frames.
   * Two approaches verified dead in the arena and therefore not used here: writing
   * the player's position struct (component writes are copies; a set_field with a
   * managed instance hard-freezes the game loop) and player.setPosWarpConsiderDogRide
   * with a create_instance vec3 (the vec3 invokes as garbage). setPlWarpInfo with a
   * Vector3f.new value plus kicking WarpFlow to WaitFadeOut is the engine's own
   * fast-travel path and the only one that actually moves the player.
   */
  teleportPlayer(target: { x: number; y: number; z: number }): void {
    this.requireTeleportScope();
    if (![target.x, target.y, target.z].every((v) => Number.isFinite(v))) throw new Error("teleport: invalid position");
    const stage = getSingleton("snow.stage.StageManager");
    if (!stage) throw new Error("teleport: stage manager missing");
    if (stage.call("get_IsWarpFlowMoving") !== false) throw new Error("teleport: warp flow already moving");
    stage.call("setPlWarpInfo(via.vec3, System.Single, snow.stage.StageManager.AreaMoveQuest)",
      Vector3f.new(target.x, target.y, target.z), 0.0, 1 /* AreaMoveQuest.Normal */);
    stage.call("set_CurrentWarpFlow", 0 /* WarpFlow.WaitFadeOut */);
  }

  private requireTeleportScope(): void {
    const q = questManager();
    const stage = getSingleton("snow.stage.StageManager");
    if (!q || !stage || (this.entryHostTest && !entryHostTestScope()) || (stage.call("get_IsQuestOnline") !== false && !(this.entryHostTest && entryHostTestScope())) ||
      q.call("isPlayQuest") !== true || q.call("get_ActiveQuestNo") !== this.cfg.quest.id) {
      throw new Error("teleport: requires the active solo custom arena quest");
    }
  }

  nearestAliveMonsterPosition(): { x: number; y: number; z: number } | null {
    this.requireTeleportScope();
    const origin = this.playerRef()?.get_field("_PosAfterMotionUpdate") as { x: number; y: number; z: number } | null;
    if (!origin || ![origin.x, origin.y, origin.z].every((v) => Number.isFinite(v))) throw new Error("teleport: local position unavailable");
    const manager = getSingleton("snow.enemy.EnemyManager");
    if (!manager) return null;
    const count = callNative(manager, "getBossEnemyCount") as number;
    if (!Number.isInteger(count) || count < 0 || count > 64) throw new Error("teleport: invalid enemy count");
    let nearest: { x: number; y: number; z: number } | null = null;
    let distance = Infinity;
    for (let i = 0; i < count; i++) {
      const enemy = callNative(manager, "getBossEnemy", i) as REManagedObject | null;
      if (!enemy || callNative(enemy, "isCapture") === true || callNative(enemy, "isDieBehaviorActive") === true) continue;
      // Live actors expose their position to reflection only through get_Pos();
      // the _Pos* fields read nil on enemies (verified in the arena, em092).
      const pos = callNative(enemy, "get_Pos") as { x: number; y: number; z: number } | null;
      if (!pos || ![pos.x, pos.y, pos.z].every((v) => Number.isFinite(v))) continue;
      const d = (pos.x - origin.x) ** 2 + (pos.y - origin.y) ** 2 + (pos.z - origin.z) ** 2;
      if (d < distance) { distance = d; nearest = { x: pos.x, y: pos.y, z: pos.z }; }
    }
    return nearest;
  }

  private playerRef(): REManagedObject | null {
    return (getSingleton("snow.player.PlayerManager")?.call("findMasterPlayer") as REManagedObject | null) ?? null;
  }


  shutdown(): void { this.testTools.shutdown(); this.policy(null, false); this.transport.cancel(); }

  now(): number { return clockSeconds(); }

  read(): RuntimeReading {
    const time = clockSeconds();
    const qm = questManager();
    if (!qm) return { time, quest: null, players: [], enemies: [], deaths: 0, online: false, canPost: false };
    const active = !!callNative(qm, "isActiveQuest");
    const playing = active && !!callNative(qm, "isPlayQuest");
    const status = qm.get_field("_QuestStatus") as number;
    const quest = active ? {
      id: callNative(qm, "get_ActiveQuestNo") as number,
      unique: callNative(qm, "getActiveQuestUniqueNo") as number, playing,
      status: status === snow_QuestManager_Status.Failed ? "failed" as const
        : status === snow_QuestManager_Status.Success ? "success" as const
          : status === snow_QuestManager_Status.Return ? "return" as const
            : playing ? "play" as const : "ready" as const,
    } : null;
    const players: PlayerReading[] = [];
    const playerManager = getSingleton("snow.player.PlayerManager");
    const array = playerManager?.get_field("PlayerList") as REManagedArray | null;
    if (array) for (let i = 0; i < array.get_size(); i++) {
      const player = array.get_element(i) as REManagedObject | null;
      if (!player) continue;
      if (playerManager?.call("isReadyPlayer", i) !== true) continue;
      const position = player.get_field("_PosAfterMotionUpdate") as { x: number; y: number; z: number } | null;
      if (position && [position.x, position.y, position.z].every((value) => typeof value === "number")) {
        players.push({ id: i, position: { x: position.x, y: position.y, z: position.z } });
      }
    }
    const stage = getSingleton("snow.stage.StageManager");
    const online = !!stage?.call("get_IsQuestOnline") || players.length > 1;
    // A prior quest lives in QuestManager until the village counter is invoked again.
    // Without this, start is refused forever after one stop and the CLI would dead-end.
    const staleQuest =
      (active ? callNative(qm, "get_ActiveQuestNo") : -1) === this.cfg.quest.id &&
      (!playing || status === snow_QuestManager_Status.Failed || status === snow_QuestManager_Status.Success) &&
      !this.questTransport.isActive();
    const enemies: EnemyReading[] = [];
    if (playing && quest?.id === this.cfg.quest.id) {
      const manager = getSingleton("snow.enemy.EnemyManager");
      if (!manager) throw new Error("Enemy manager missing during the arena quest");
      const count = callNative(manager, "getBossEnemyCount") as number;
      if (!Number.isInteger(count) || count < 0 || count > 64) throw new Error("Invalid native boss-list count");
      for (let i = 0; i < count; i++) {
        const enemy = callNative(manager, "getBossEnemy", i) as REManagedObject | null;
        if (!enemy) continue;
        const uid = callNative(enemy, "get_UniqueId") as number;
        const typeId = callNative(enemy, "get_EnemyType") as number;
        const health = this.testTools.getHealth(uid);
        if (!health) continue;
        const hp = health.hp;
        const maxHp = health.maxHp;
        if (typeof uid !== "number" || typeof typeId !== "number") throw new Error("Invalid native enemy identity");
        if (typeof hp !== "number" || typeof maxHp !== "number" || maxHp <= 0) continue;
        const nativeDead = qm.get_field("_QuestTargetEmDieUidList") as REManagedObject | null;
        const captured = !!callNative(enemy, "isCapture");
        const dead = !!nativeDead?.call("Contains", uid) || (maxHp > 0 && hp <= 0 && !!callNative(enemy, "isDieBehaviorActive"));
        // Native death callbacks are not guaranteed on every dynamically registered actor.
        // Feed the same conservative evidence used by RunSession into the sequential queue.
        if (captured || dead) this.inplace.death(uid);
        // Live actors expose their position to reflection only through get_Pos();
        // the _Pos* fields read nil on enemies (verified in the arena, em092).
        const position = callNative(enemy, "get_Pos") as { x: number; y: number; z: number } | null;
        const pos = position && [position.x, position.y, position.z].every((v) => Number.isFinite(v))
          ? { x: position.x, y: position.y, z: position.z } : undefined;
        enemies.push({ uid, typeId, captured, dead, position: pos });
      }
    }
    const gui = getSingleton("snow.gui.GuiManager");
    return { time, quest, players, enemies, online, staleQuest,
      deaths: active ? callNative(qm, "getDeathNum") as number : 0,
      canPost: !active && (!!gui?.call("IsCanInvokeQuestBoard") || !!getSingleton("snow.gui.fsm.questcounter.GuiQuestCounterFsmManager")) };
  }

  private readonly wearPort: EquipWearPort = {
    beginPouchIsolation: () => beginPouchIsolation(),
    endPouchIsolation: () => endPouchIsolation(),
  };
  private startupNotice: string | null = null;

  /** M3.5 开局准备：穿装 + 零物资袋隔离。不抛异常；袋隔离失败不阻断（返回 notice）。 */
  startupPrepare(armor: string): { ok: boolean; reason?: string; notice?: string } {
    const sets = this.cfg.armorSets ?? {};
    const spec = sets[armor];
    if (!spec) return { ok: false, reason: `配置缺少开局套装定义: ${armor}` };
    const rules = this.cfg.startupRules ?? DEFAULT_STARTUP_RULES;
    this.startupNotice = null;
    const report = equipStartupSet(armor, spec.series, rules, this.wearPort);
    if (!report.ok) return { ok: false, reason: report.reason ?? "开局穿装失败" };
    const notice = report.pouchReason ? `零物资隔离未完成：${report.pouchReason}` : undefined;
    this.startupNotice = notice ?? null;
    return { ok: true, ...(notice ? { notice } : {}) };
  }

  /** V1.3 §2.3 极强击杀掉落：gacha_4 一次，发件并入局末清理（复用件不追踪不清理）。 */
  ultimateDrop(): { ok: boolean; name?: string; reused?: boolean; reason?: string } {
    if (!this.gacha) return { ok: false, reason: "GachaService unavailable" };
    const rolled = this.gacha.roll("gacha_4");
    if (!rolled.ok) return { ok: false, reason: rolled.reason ?? "抽取失败" };
    relog.info(`[MhwRogue] 极强击杀掉落：抽取获得：${rolled.name ?? rolled.id}${rolled.reused ? "（已有，复用不清理）" : ""}`);
    return { ok: true, name: rolled.name, reused: rolled.reused };
  }

  /** M3.5 回村恢复（equip_wear.restoreStartup 幂等；失败保持待办由 session 重试）。 */
  startupRestore(): { ok: boolean; reason?: string } {
    const report = restoreStartup(this.wearPort);
    if (report.ok) this.startupNotice = null;
    return report.ok ? { ok: true } : { ok: false, reason: report.reason };
  }

  finish(failed: boolean): void {
    const qm = questManager();
    if (!qm || callNative(qm, "get_ActiveQuestNo") !== this.cfg.quest.id || !callNative(qm, "isActiveQuest")) {
      throw new Error("Refusing to finish an unrelated quest");
    }
    this.holdClear = false;
    if (failed) callNative(qm, "setQuestFail", snow_quest_FailReason.Normal);
    else callNative(qm, "setQuestClear");
  }

  report(event: string, detail: unknown): void {
    const report = { time: clockSeconds(), event, detail };
    this.events.push(report);
    if (this.events.length > 100) this.events.shift();
    relog.info(`[MhwRogue] ${event}`);
    try {
      rejson.dump_file("mhw_rogue_runtime.json", { version: 2, last: report, events: this.events,
        ready: this.ready(), status: this.status(), plan: this.activePlan }, 2);
      if (event === "runtime-error" || event === "hook-install-error") rejson.dump_file("mhw_rogue_runtime_error.json", report, 2);
      if (["sequential-spawn", "overlapping-spawns", "wave-cleared"].includes(event)) {
        rejson.dump_file("mhw_rogue_spawn_evidence.json", { events: this.events, observationOnly: true }, 2);
      }
    } catch (error) { relog.warn(`[MhwRogue] diagnostic write failed: ${String(error)}`); }
  }

  private inScope(): boolean {
    if (!this.activePlan) return false;
    try {
      const qm = questManager();
      const stage = getSingleton("snow.stage.StageManager");
      const hostTest = this.entryHostTest && entryHostTestScope();
      return !!qm && (!this.entryHostTest || hostTest) && (!stage?.call("get_IsQuestOnline") || hostTest) && !!callNative(qm, "isActiveQuest") &&
        callNative(qm, "get_ActiveQuestNo") === this.activePlan.questId;
    } catch { return false; }
  }

  private matches(object: unknown): REManagedObject | null {
    if (!this.inScope()) return null;
    try {
      const enemy = toManagedObject(object);
      const type = callNative(enemy, "get_EnemyType") as number;
      return this.activePlan!.monsterIds.includes(type) ? enemy : null;
    } catch { return null; }
  }

  private rate(kind: string, original: number, multiplier: number): number {
    const key = `${kind}:${this.activePlan?.token ?? -1}`;
    if (!this.rateKeys.includes(key)) {
      this.rateKeys.push(key);
      // Only queue plain data inside hooks; write JSON on the next normal frame.
      this.rateEvidence.push({ kind, token: this.activePlan?.token, original,
        multiplier, result: original * multiplier });
    }
    return original * multiplier;
  }

  private installHooks(): void {
    const lookup = (type: string, name: string) => {
      const method = findTypeDefinition(type)?.get_method(name);
      if (!method) throw new Error(`Runtime API missing: ${type}.${name}`);
      return method;
    };
    const qmType = "snow.QuestManager";
    const emType = "snow.enemy.EnemyCharacterBase";
    lookup(emType, "update");
    const clear = lookup(qmType, "setQuestClear");
    const clearSub = lookup(qmType, "setQuestClearSub");
    const check = lookup(qmType, "checkQuestClear");
    const over = lookup(qmType, "isQuestTimeOver");
    const unlimited = lookup(qmType, "isQuestMaxTimeUnlimited");
    const died = lookup(qmType, "questEnemyDie");
    const vital = lookup(emType, "getDifficultyRateVital");
    const attack = lookup(emType, "getDifficultyRateAttack");
    const preClear = (): number => this.inScope() && this.holdClear ? PRE_HOOK.SKIP_ORIGINAL : PRE_HOOK.CALL_ORIGINAL;
    // Explicit this:void on host callback types in sdk.ts prevents hidden Lua self arguments.
    hookMethod(clear, preClear);
    hookMethod(clearSub, preClear);
    hookMethod(check, () => {}, (retval) => this.inScope() && this.holdClear ? toPtr(0) : retval);
    hookMethod(over, () => {}, (retval) => this.inScope() ? toPtr(0) : retval);
    hookMethod(unlimited, () => {}, (retval) => this.inScope() ? toPtr(1) : retval);
    hookMethod(died, (args) => {
      const enemy = this.matches(args[3]);
      const kind = toInt64(args[4]);
      if (enemy && (kind === snow_quest_EmEndType.Die || kind === snow_quest_EmEndType.Capture)) {
        this.inplace.death(callNative(enemy, "get_UniqueId") as number);
        this.deaths.push({ uid: callNative(enemy, "get_UniqueId") as number,
          typeId: callNative(enemy, "get_EnemyType") as number,
          kind: kind === snow_quest_EmEndType.Die ? "kill" : "capture" });
      }
      return PRE_HOOK.CALL_ORIGINAL;
    });
    hookMethod(vital, (args) => {
      const storage = reframework.getHookStorage();
      storage[`mhw_rogue_hp_mul_${this.cfg.quest.id}`] = this.matches(args[2]) &&
        toInt64(args[3]) === snow_enemy_EnemyDef_VitalCategory.Hp &&
        toInt64(args[4]) === snow_enemy_EnemyDef_NandoGetType.All ? this.activePlan!.wave.hpMul : 1;
      return PRE_HOOK.CALL_ORIGINAL;
    }, (retval) => {
      const mul = reframework.getHookStorage()[`mhw_rogue_hp_mul_${this.cfg.quest.id}`] as number;
      return mul !== 1 ? floatToPtr(this.rate("hp", toFloat(retval), mul)) : retval;
    });
    hookMethod(attack, (args) => {
      reframework.getHookStorage()[`mhw_rogue_dmg_mul_${this.cfg.quest.id}`] = this.matches(args[2]) ? this.activePlan!.wave.dmgMul : 1;
      return PRE_HOOK.CALL_ORIGINAL;
    }, (retval) => {
      const mul = reframework.getHookStorage()[`mhw_rogue_dmg_mul_${this.cfg.quest.id}`] as number;
      return mul !== 1 ? floatToPtr(this.rate("attack", toFloat(retval), mul)) : retval;
    });
    this.hooks = true;
    this.report("runtime-hooks-installed", { scope: this.cfg.quest.id, online: this.entryHostTest ? "one-host-test" : "disabled" });
  }
}
