import { InplaceWaves } from "./inplace_waves";
import { TestTools } from "./test_tools";
import type { RogueConfig } from "../core/config";
import { DEFAULT_RUNTIME, type QuestPlan } from "../core/quest_plan";
import type { DeathReading, EnemyReading, PlayerReading, RuntimeReading, SessionPort } from "../core/run_session";
import { QuestInstaller } from "./quest_installer";
import { QuestTransport } from "./quest_transport";
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
  readonly testTools = new TestTools((event, detail) => this.report(event, detail));
  private readonly inplace = new InplaceWaves((event, detail) => this.report(event, detail));
  private activePlan: QuestPlan | null = null;
  private holdClear = false;
  private hooks = false;
  private bootError: string | null = null;
  private deaths: DeathReading[] = [];
  private events: Diagnostic[] = [];
  private rateKeys: string[] = [];
  private rateEvidence: unknown[] = [];

  constructor(private readonly cfg: RogueConfig, readonly installer: QuestInstaller) {
    this.transport = new QuestTransport(() => installer.getQuest(),
      (cfg.runtime ?? DEFAULT_RUNTIME).postTimeoutSeconds);
  }

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
  post(questId: number): void { this.transport.request(questId); }
  cancelPost(): void { this.transport.cancel(); }
  postingError(): string | null { return this.transport.getError(); }
  takeDeaths(): DeathReading[] { const events = this.deaths; this.deaths = []; return events; }
  shutdown(): void { this.testTools.shutdown(); this.policy(null, false); this.transport.cancel(); }

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
      if (position && [position.x, position.y, position.z].every((value) => Number.isFinite(value))) {
        players.push({ id: i, position: { x: position.x, y: position.y, z: position.z } });
      }
    }
    const stage = getSingleton("snow.stage.StageManager");
    const online = !!stage?.call("get_IsQuestOnline") || players.length > 1;
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
        if (!Number.isFinite(uid) || !Number.isFinite(typeId)) throw new Error("Invalid native enemy identity");
        if (!Number.isFinite(hp) || !Number.isFinite(maxHp) || maxHp <= 0) continue;
        const nativeDead = qm.get_field("_QuestTargetEmDieUidList") as REManagedObject | null;
        const captured = !!callNative(enemy, "isCapture");
        const dead = !!nativeDead?.call("Contains", uid) || (maxHp > 0 && hp <= 0 && !!callNative(enemy, "isDieBehaviorActive"));
        // Native death callbacks are not guaranteed on every dynamically registered actor.
        // Feed the same conservative evidence used by RunSession into the sequential queue.
        if (captured || dead) this.inplace.death(uid);
        enemies.push({ uid, typeId, captured, dead });
      }
    }
    const gui = getSingleton("snow.gui.GuiManager");
    return { time, quest, players, enemies, online,
      deaths: active ? callNative(qm, "getDeathNum") as number : 0,
      canPost: !active && (!!gui?.call("IsCanInvokeQuestBoard") || !!getSingleton("snow.gui.fsm.questcounter.GuiQuestCounterFsmManager")) };
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
      return !!qm && !stage?.call("get_IsQuestOnline") && !!callNative(qm, "isActiveQuest") &&
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
      storage.mhw_rogue_hp_mul = this.matches(args[2]) &&
        toInt64(args[3]) === snow_enemy_EnemyDef_VitalCategory.Hp &&
        toInt64(args[4]) === snow_enemy_EnemyDef_NandoGetType.All ? this.activePlan!.wave.hpMul : 1;
      return PRE_HOOK.CALL_ORIGINAL;
    }, (retval) => {
      const mul = reframework.getHookStorage().mhw_rogue_hp_mul as number;
      return mul !== 1 ? floatToPtr(this.rate("hp", toFloat(retval), mul)) : retval;
    });
    hookMethod(attack, (args) => {
      reframework.getHookStorage().mhw_rogue_dmg_mul = this.matches(args[2]) ? this.activePlan!.wave.dmgMul : 1;
      return PRE_HOOK.CALL_ORIGINAL;
    }, (retval) => {
      const mul = reframework.getHookStorage().mhw_rogue_dmg_mul as number;
      return mul !== 1 ? floatToPtr(this.rate("attack", toFloat(retval), mul)) : retval;
    });
    this.hooks = true;
    this.report("runtime-hooks-installed", { scope: this.cfg.quest.id, online: "disabled" });
  }
}
