import { snow_QuestManager_BossSetCondition } from "./gen/enums/snow_QuestManager_BossSetCondition";
import type { QuestPlan } from "../core/quest_plan";
import { createInstance, getSingleton, questManager, type REManagedArray, type REManagedObject } from "./sdk";

/** Experimental backend: fresh identities, native loader, reusable task/order slots.
 * A wave uses free slots without changing a corpse or calling the creator directly.
 */
export interface SpawnTicket { token: number; ordinal: number; type: number; slot: number; id: number; uid: number }
export interface SpawnSync {
  role: "host" | "guest";
  valid(): boolean;
  expected(): SpawnTicket | null;
  canStage?(): boolean;
  staged(ticket: SpawnTicket): void;
  activate(ticket: SpawnTicket): boolean;
}
export class InplaceWaves {
  private sync: SpawnSync | null = null;
  private staged: SpawnTicket | null = null;
  setSync(sync: SpawnSync): void { this.sync = sync; }
  private plan: QuestPlan | null = null;
  private unique = 0;
  private pending: number[] = [];
  private issued: number[] = [];
  private ended: number[] = [];
  private nextPoll = 0;
  waitingForCapacity = false;
  status = "inPlace inactive";
  constructor(private readonly report: (event: string, detail: unknown) => void,
    private readonly configureSlot: (plan: QuestPlan, slot: number, type: number, id: number) => void = () => {},
    private readonly allowEntryHostTest: () => boolean = () => false) {}

  prepare(plan: QuestPlan): void {
    const q = this.scope(plan);
    const em = getSingleton("snow.enemy.EnemyManager");
    if (!em || plan.mapNo !== 10 || plan.monsterIds.length < 1 || plan.monsterIds.length > 2) throw new Error("Unsupported inPlace wave");
    if (((em.get_field("_EnemySetInfoList") as REManagedObject).call("get_Count") as number) + plan.monsterIds.length > 512) throw new Error("inPlace record safety limit reached; finish and reenter the quest");
    const corpses: REManagedObject[] = [];
    for (let i = 0; i < (em.call("getBossEnemyCount") as number); i++) {
      const e = em.call("getBossEnemy", i) as REManagedObject;
      if (!e.call("isDieBehaviorActive") && !e.call("isCapture")) throw new Error("Previous native bosses are still alive");
      corpses.push(e);
    }
    // prepare() is reached only after the carve interval, gathering and next choice.
    // Let the native destruction queue release actors/slots; never erase a live boss.
    for (const corpse of corpses) em.call("registerRequestDestroyEnemyList", corpse);
    this.plan = plan;
    this.unique = q.call("getActiveQuestUniqueNo") as number;
    this.pending = [...plan.monsterIds]; this.issued = []; this.ended = []; this.nextPoll = 0;
    this.waitingForCapacity = false; this.staged = null;
    this.status = "inPlace waiting for reusable native slots";
  }
  cancel(): void { this.staged = null; this.waitingForCapacity = false; this.plan = null; this.pending = []; this.issued = []; this.ended = []; this.status = "inPlace inactive"; }
  death(uid: number): void { if (this.issued.includes(uid) && !this.ended.includes(uid)) this.ended.push(uid); }

  tick(now: number): void {
    if (!this.plan || (this.pending.length === 0 && !this.staged) || now < this.nextPoll) return;
    this.nextPoll = now + 1;
    const q = this.scope(this.plan);
    if (q.call("getActiveQuestUniqueNo") !== this.unique) throw new Error("inPlace quest identity changed");
    if (this.staged) {
      if (!this.sync?.valid()) throw new Error("Multiplayer spawn session ended");
      if (!this.sync.activate(this.staged)) { this.status = "inPlace waiting all peers to stage native record"; return; }
      q.set_field("_BossSetCount", 2); q.set_field("_ExtraEmRno", 5);
      this.report("in-place-synchronized-activate", this.staged);
      this.staged = null; return;
    }
    if (this.sync?.role === "host" && this.sync.canStage?.() === false) { this.status = "inPlace waiting peers to activate previous spawn"; return; }
    const expected = this.sync?.role === "guest" ? this.sync.expected() : null;
    if (this.sync?.role === "guest" && (!expected || expected.token !== this.plan.token || expected.ordinal !== this.issued.length)) return;
    if (this.plan.sequential && this.issued.some((uid) => !this.ended.includes(uid))) {
      this.status = `inPlace waiting death: issued=${this.issued.join(",")} ended=${this.ended.join(",")}`;
      return;
    }
    const em = getSingleton("snow.enemy.EnemyManager")!;
    if (q.get_field("_ExtraEmRno") !== 10) { this.status = "inPlace waiting native scheduler"; return; }
    for (let i = 0; i < (em.call("getBossEnemyCount") as number); i++) {
      const e = em.call("getBossEnemy", i) as REManagedObject;
      if (!e.call("isDieBehaviorActive") && !e.call("isCapture") &&
          (this.plan.sequential || !this.issued.includes(e.call("get_UniqueId") as number))) { this.status = `inPlace waiting actor ${e.call("get_UniqueId")} to end`; return; }
    }
    this.waitingForCapacity = (em.call("getBossEnemyCount") as number) >= 3;
    if (this.waitingForCapacity) { this.status = "inPlace waiting native actor capacity (corpses still occupy actors)"; return; }
    const slots = q.get_field("_BossSet") as REManagedArray;
    const freeSlots: number[] = [];
    for (let i = 2; i < slots.get_size(); i++) {
      if ((slots.get_element(i) as REManagedObject).get_field("EmSetId") === -1) freeSlots.push(i);
    }
    const order = q.get_field("_BossSetNoTbl") as REManagedArray;
    if (slots.get_size() < 4 || order.get_size() < 5) throw new Error("Unexpected native boss-array capacity");
    // Native CheckNext stops on DEFAULT. Kick RequestLoad once per actor;
    // simultaneous groups allow already-issued living actors to remain.
    const ids = this.pending.slice(0, 1);
    if (expected) {
      if (expected.type !== ids[0]) throw new Error("Host spawn type differs from accepted wave");
      if (!freeSlots.includes(expected.slot)) { this.status = "inPlace waiting host slot to become free"; return; }
      freeSlots.splice(0, freeSlots.length, expected.slot);
    }
    if (freeSlots.length < ids.length) { this.status = "inPlace waiting free task slots"; return; }
    const source = (em.call("getEnemySetInfo(System.Int32)", 0) as REManagedObject).call("get_EnemySetParam") as REManagedObject;
    if (!source) throw new Error("Original native spawn parameters missing");
    const fresh: { id: number; uid: number; type: number }[] = [];
    for (const type of ids) {
      const param = createInstance("snow.quest.BossSetParam", true);
      if (!param) throw new Error("Cannot allocate native boss parameters");
      // Lua tracks this reference and releases it when the wrapper is collected.
      // The registered EnemySetInfo keeps the parameter alive after publication.
      param.add_ref();
      {
        param.call(".ctor()");
        for (const name of ["HideGroup", "_SetPos", "_SetRot", "_SubType", "_BlockNo", "_IndividualType", "_RouteNo"]) param.set_field(name, source.get_field(name));
        param.set_field("_TypeValue", type);
        const record = em.call("createEnemySetInfo(snow.quest.EnemySetParam)", param) as REManagedObject;
        if (!record || record.call("get_SetStatus") !== 0) throw new Error("Native registration failed");
        const entry = { id: record.call("get_EmSetId") as number, uid: record.call("get_UniqueId") as number, type };
        if (expected && (entry.id !== expected.id || entry.uid !== expected.uid)) throw new Error("Native enemy identity differs across peers; stopping before activation");
        fresh.push(entry);
      }
    }
    // Publish the complete group before restarting the native scheduler.
    for (let i = 2; i < order.get_size(); i++) order.call("Set", i, -1);
    fresh.forEach((entry, i) => {
      const slotNo = freeSlots[i]!;
      this.configureSlot(this.plan!, slotNo, entry.type, entry.id);
      const slot = slots.get_element(slotNo) as REManagedObject;
      slot.set_field("EmSetId", entry.id); slot.set_field("EmType", entry.type); slot.set_field("State", 0);
      slot.set_field("Param0", 0); slot.set_field("Param1", 0);
      (q.get_field("_BossSetCond") as REManagedObject).call("Set", slotNo, snow_QuestManager_BossSetCondition.DEFAULT);
      (q.get_field("_BossLoadStartOk") as REManagedObject).call("Set", slotNo, false);
      (q.get_field("_BossLoadDone") as REManagedObject).call("Set", slotNo, 0);
      order.call("Set", 2 + i, slotNo);
      this.issued.push(entry.uid);
    });
    this.pending.splice(0, ids.length);
    if (this.sync) {
      this.staged = { token: this.plan.token, ordinal: this.issued.length - 1, type: fresh[0]!.type,
        slot: freeSlots[0]!, id: fresh[0]!.id, uid: fresh[0]!.uid };
      this.sync.staged(this.staged);
    } else { q.set_field("_BossSetCount", 2); q.set_field("_ExtraEmRno", 5); }
    this.status = `inPlace native load: ${fresh.map((e) => `${e.type}/${e.uid}`).join(", ")}`;
    this.report("in-place-native-load", { token: this.plan.token, unique: this.unique, fresh, taskSlots: freeSlots.slice(0, ids.length), remaining: this.pending.length });
  }

  private scope(plan: QuestPlan): REManagedObject {
    const q = questManager();
    const stage = getSingleton("snow.stage.StageManager");
    const multiplayer = this.sync?.valid() === true;
    if (plan.questId === 900103 && !this.allowEntryHostTest() && !multiplayer) throw new Error("Entry host test scope ended");
    if (!q || !stage || (stage.call("get_IsQuestOnline") === true && !this.allowEntryHostTest() && !multiplayer) || q.call("isPlayQuest") !== true || q.call("get_ActiveQuestNo") !== plan.questId) throw new Error("inPlace requires the owned solo arena quest");
    return q;
  }
}
