import { findTypeDefinition, getSingleton, hookMethod, PRE_HOOK, questManager, toManagedObject, toPtr, clockSeconds, type REManagedObject } from "./sdk";

function callNative(object: REManagedObject, name: string, ...args: unknown[]): unknown {
  try { return object.call(name, ...args); }
  catch (error) { throw new Error(`${name}: ${String(error)}`); }
}

/** Temporary combat helpers. No save/equipment edits; only our two solo arena quests. */
export class TestTools {
  invincible = false;
  message = "Test cheats are OFF. Solo custom arena only.";
  private hooks = false;
  private killRequested = false;
  private observer = false;
  private bossUids: number[] = [];
  private killUntil = 0;
  private killTargets: number[] = [];
  private questUnique: number | null = null;
  private killed: number[] = [];
  private lastStock: Record<string, number> = {};
  private health: { uid: number; hp: number; maxHp: number; at: number }[] = [];
  private pending: { event: string; detail: unknown }[] = [];
  getHealth(uid: number): { hp: number; maxHp: number } | null {
    return this.health.find((entry) => entry.uid === uid && clockSeconds() - entry.at < 3) ?? null;
  }
  private observe(): void {
    if (this.observer) return;
    const update = findTypeDefinition("snow.enemy.EnemyCharacterBase")?.get_method("update");
    if (!update) throw new Error("Enemy update API missing");
    hookMethod(update, (args) => {
      if (!this.scoped()) return PRE_HOOK.CALL_ORIGINAL;
      try {
        const enemy = toManagedObject(args[2]);
        const uid = callNative(enemy, "get_UniqueId") as number;
        if (!this.bossUids.includes(uid)) return PRE_HOOK.CALL_ORIGINAL;
        const physical = enemy.get_field("<PhysicalParam>k__BackingField") as REManagedObject | null;
        const vital = physical?.call("getVital", 0, 0) as REManagedObject | null;
        if (!vital) return PRE_HOOK.CALL_ORIGINAL;
        const hp = callNative(vital, "get_Current") as number;
        const maxHp = callNative(vital, "get_Max") as number;
        const at = clockSeconds();
        if (this.killUntil >= at && this.killTargets.includes(uid) && hp >= 0 && (this.lastStock[String(uid)] === undefined || at - this.lastStock[String(uid)]! >= 1) && !callNative(enemy, "isCapture") && !callNative(enemy, "isDieBehaviorActive")) {
          callNative(enemy, "stockDirectForceKillDamage");
          this.lastStock[String(uid)] = at;
          if (!this.killed.includes(uid)) {
            this.killed.push(uid);
            this.pending.push({ event: "test-kill", detail: { uid, hpBefore: hp, nativeDeathsOnly: true } });
          }
        }
        const entry = { uid, hp, maxHp, at };
        const old = this.health.findIndex((item) => item.uid === uid);
        if (old < 0) this.health.push(entry); else this.health[old] = entry;
      } catch (error) {
        if (this.message !== String(error)) this.pending.push({ event: "test-tools-error", detail: String(error) });
        this.message = String(error);
      }
      return PRE_HOOK.CALL_ORIGINAL;
    });
    this.observer = true;
  }
  constructor(private readonly report: (event: string, detail: unknown) => void) {}

  private scoped(): boolean {
    const qm = questManager();
    const stage = getSingleton("snow.stage.StageManager");
    if (!qm || !stage || callNative(stage, "get_IsQuestOnline")) return false;
    return !!callNative(qm, "isPlayQuest") && [900101, 900102].includes(callNative(qm, "get_ActiveQuestNo") as number);
  }

  toggleGod(): void {
    try {
      if (!this.hooks) {
        const td = findTypeDefinition("snow.player.PlayerQuestBase");
        const check = td?.get_method("checkMuteki");
        const damage = td?.get_method("damageVital");
        const slip = td?.get_method("damageVitalSlip");
        if (!check || !damage || !slip) throw new Error("Player invincibility APIs missing");
        const protectedNow = () => this.invincible && this.scoped();
        hookMethod(check, () => {}, (value) => protectedNow() ? toPtr(1) : value);
        const block = () => protectedNow() ? PRE_HOOK.SKIP_ORIGINAL : PRE_HOOK.CALL_ORIGINAL;
        hookMethod(damage, block);
        hookMethod(slip, block);
        this.hooks = true;
      }
      this.invincible = !this.invincible;
      this.message = `Invincible ${this.invincible ? "ON" : "OFF"} (solo custom arena only)`;
      this.report("test-invincible", { enabled: this.invincible });
    } catch (error) { this.message = String(error); this.report("test-tools-error", this.message); }
  }

  requestKill(): void { this.killRequested = true; }
  tick(): void {
    if (this.scoped()) this.observe();
    this.bossUids = [];
    if (this.scoped()) {
      const unique = callNative(questManager()!, "getActiveQuestUniqueNo") as number;
      if (unique !== this.questUnique) { this.health = []; this.questUnique = unique; this.killUntil = 0; this.killTargets = []; }
      const manager = getSingleton("snow.enemy.EnemyManager");
      if (manager) {
        const count = callNative(manager, "getBossEnemyCount") as number;
        if (Number.isInteger(count) && count >= 0 && count <= 64) for (let i = 0; i < count; i++) {
          const enemy = callNative(manager, "getBossEnemy", i) as REManagedObject | null;
          if (enemy) this.bossUids.push(callNative(enemy, "get_UniqueId") as number);
        }
      }
    }
    const events = this.pending; this.pending = [];
    for (const event of events) {
      if (event.event === "test-kill") this.message = `Killed ${this.killed.length} spawned monsters; waiting for native death events`;
      this.report(event.event, event.detail);
    }
    if (!this.killRequested) return;
    this.killRequested = false;
    if (!this.scoped()) { this.message = "Enter solo arena quest 900101/900102 first"; return; }
    this.killed = [];
    this.killTargets = [...this.bossUids];
    this.lastStock = {};
    this.killUntil = clockSeconds() + 10;
    this.message = "Kill queued for spawned monsters (native update)";
  }
  shutdown(): void { this.invincible = false; this.killRequested = false; this.killUntil = 0; }
}
