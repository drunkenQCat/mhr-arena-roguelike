/** Purchased bonuses belong to one roguelike wave, not the native quest lifetime. */
import { findTypeDefinition, getSingleton, hookMethod, toInt64, toPtr, relog,
  type REManagedObject } from "./sdk";
import type { RuntimeReading, SessionStage } from "../core/run_session";
import type { BuffAmounts } from "../core/config";
export type BuffKind = "buff_atk" | "buff_def" | "buff_crit";
export interface BuffPending { atk: number; def: number; crit: number }
export interface BuffScope { stage: SessionStage; layer: number; questId: number; multiplayer?: boolean }
const empty = (): BuffPending => ({ atk: 0, def: 0, crit: 0 });
function masterPlayerData(): REManagedObject | null {
  const pm = getSingleton("snow.player.PlayerManager");
  const player = pm?.call("findMasterPlayer") as REManagedObject | null;
  return player?.call("get_PlayerData") as REManagedObject | null;
}
export class BuffService {
  private pending = empty();
  private active = empty();
  private layer: number | null = null;
  private appliedUnique: number | null = null;
  private appliedDeaths = -1;
  private data: REManagedObject | null = null;
  private previous: Record<string, number> = {};
  private written: Record<string, number> = {};
  private hookInstalled = false;
  private critBonus = 0;
  private lastStatRead = -1;
  constructor(private readonly amounts: BuffAmounts) {}
  addPending(kind: BuffKind): { ok: boolean; total: number } {
    if (kind === "buff_atk") this.pending.atk += this.amounts.atk;
    else if (kind === "buff_def") this.pending.def += this.amounts.def;
    else if (kind === "buff_crit") {
      if (!findTypeDefinition("snow.equip.MainWeaponBaseData")?.get_method("get_CriticalRate"))
        return { ok: false, total: 0 };
      this.pending.crit += 1;
    } else return { ok: false, total: 0 };
    return { ok: true, total: kind === "buff_atk" ? this.pending.atk :
      kind === "buff_def" ? this.pending.def : this.pending.crit * this.amounts.crit };
  }
  snapshot(): BuffPending { return { ...this.pending }; }
  diagnostic() { return { pending: { ...this.pending }, active: { ...this.active }, layer: this.layer,
    appliedUnique: this.appliedUnique, critBonus: this.critBonus }; }
  private restoreFields(): void {
    const data = this.data;
    if (data) for (const field of Object.keys(this.written)) {
      try {
        // Do not overwrite a later native potion/cart update.
        if (data.get_field(field) === this.written[field]) data.set_field(field, this.previous[field]!);
      } catch { /* retired player object; native teardown owns it */ }
    }
    this.data = null; this.previous = {}; this.written = {}; this.appliedUnique = null;
    this.lastStatRead = -1;
    this.critBonus = 0;
  }
  shutdown(): void { this.restoreFields(); this.pending = empty(); this.active = empty(); this.layer = null; }
  tick(reading: RuntimeReading | null, scope: BuffScope): void {
    if (["Idle", "Finished", "Fault"].includes(scope.stage) || (reading?.online && !scope.multiplayer)) { this.shutdown(); return; }
    if (scope.stage === "Carve" || (this.layer !== null && this.layer !== scope.layer)) {
      this.restoreFields(); this.active = empty(); this.layer = null;
    }
    const q = reading?.quest;
    if (scope.stage !== "Combat" || !q?.playing || q.id !== scope.questId) {
      if (this.appliedUnique !== null) this.restoreFields();
      return;
    }
    if (this.layer === null) {
      this.active = this.pending; this.pending = empty(); this.layer = scope.layer;
    }
    if (this.active.atk === 0 && this.active.def === 0 && this.active.crit === 0) return;
    if (this.lastStatRead === reading!.time) return;
    this.lastStatRead = reading!.time;
    try {
      const data = masterPlayerData();
      if (!data) return;
      if (this.active.crit > 0 && !this.hookInstalled) {
        const method = findTypeDefinition("snow.equip.MainWeaponBaseData")?.get_method("get_CriticalRate");
        if (!method) throw new Error("Critical-rate getter unavailable");
        // Pure post hook: no managed-object traversal, player reads, feedback or cross-call state.
        hookMethod(method, undefined, (retval) => {
          if (this.critBonus === 0) return retval;
          let original = toInt64(retval) % 4294967296;
          if (original >= 2147483648) original -= 4294967296;
          return toPtr(original + this.critBonus);
        });
        this.hookInstalled = true;
      }
      if (this.appliedUnique === q.unique && this.data === data && this.appliedDeaths === reading!.deaths) return;
      this.restoreFields();
      this.data = data;
      for (const [field, bonus] of [["_AtkUpAlive", this.active.atk], ["_DefUpAlive", this.active.def]] as const) {
        if (bonus === 0) continue;
        const original = data.get_field(field) as number;
        if (typeof original !== "number" || !Number.isFinite(original)) throw new Error("Invalid player stat");
        this.previous[field] = original;
        this.written[field] = original + bonus;
        data.set_field(field, original + bonus);
        if (data.get_field(field) !== original + bonus) throw new Error("Buff readback failed");
      }
      this.appliedUnique = q.unique; this.appliedDeaths = reading!.deaths; this.lastStatRead = reading!.time;
      this.critBonus = this.active.crit * this.amounts.crit;
      relog.info(`[MhwRogue] wave buff applied: layer=${this.layer} atk=${this.active.atk} def=${this.active.def} crit=${this.critBonus}`);
    } catch (error) {
      this.restoreFields();
      this.lastStatRead = reading!.time;
      // One failed application must not produce a per-frame log storm.
      if (this.failure !== String(error)) { this.failure = String(error); relog.error(`[MhwRogue] buff: ${this.failure}`); }
    }
  }
  private failure: string | null = null;
}
