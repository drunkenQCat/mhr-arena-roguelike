import { snow_QuestManager_BossSetCondition } from "./gen/enums/snow_QuestManager_BossSetCondition";
import type { QuestPlan } from "../core/quest_plan";
import { createInstance, getSingleton, questManager, type REManagedArray, type REManagedObject } from "./sdk";

/** Experimental backend: fresh identities, native loader, reusable task/order slots.
 * A wave uses free slots without changing a corpse or calling the creator directly.
 */
export class InplaceWaves {
  private plan: QuestPlan | null = null;
  private unique = 0;
  private pending: number[] = [];
  private issued: number[] = [];
  private ended: number[] = [];
  private nextPoll = 0;
  status = "inPlace inactive";
  constructor(private readonly report: (event: string, detail: unknown) => void) {}

  prepare(plan: QuestPlan): void {
    const q = this.scope(plan);
    const em = getSingleton("snow.enemy.EnemyManager");
    if (!em || plan.mapNo !== 10 || plan.monsterIds.length < 1 || plan.monsterIds.length > 2) throw new Error("Unsupported inPlace wave");
    if (((em.get_field("_EnemySetInfoList") as REManagedObject).call("get_Count") as number) + plan.monsterIds.length > 512) throw new Error("inPlace record safety limit reached; finish and reenter the quest");
    for (let i = 0; i < (em.call("getBossEnemyCount") as number); i++) {
      const e = em.call("getBossEnemy", i) as REManagedObject;
      if (!e.call("isDieBehaviorActive") && !e.call("isCapture")) throw new Error("Previous native bosses are still alive");
    }
    this.plan = plan;
    this.unique = q.call("getActiveQuestUniqueNo") as number;
    this.pending = [...plan.monsterIds]; this.issued = []; this.ended = []; this.nextPoll = 0;
    this.status = "inPlace waiting for reusable native slots";
  }
  cancel(): void { this.plan = null; this.pending = []; this.issued = []; this.ended = []; this.status = "inPlace inactive"; }
  death(uid: number): void { if (this.issued.includes(uid) && !this.ended.includes(uid)) this.ended.push(uid); }

  tick(now: number): void {
    if (!this.plan || this.pending.length === 0 || now < this.nextPoll) return;
    this.nextPoll = now + 1;
    const q = this.scope(this.plan);
    if (q.call("getActiveQuestUniqueNo") !== this.unique) throw new Error("inPlace quest identity changed");
    if (this.plan.sequential && this.issued.some((uid) => !this.ended.includes(uid))) {
      this.status = `inPlace waiting death: issued=${this.issued.join(",")} ended=${this.ended.join(",")}`;
      return;
    }
    const em = getSingleton("snow.enemy.EnemyManager")!;
    if (q.get_field("_ExtraEmRno") !== 10) { this.status = "inPlace waiting native scheduler"; return; }
    for (let i = 0; i < (em.call("getBossEnemyCount") as number); i++) {
      const e = em.call("getBossEnemy", i) as REManagedObject;
      if (!e.call("isDieBehaviorActive") && !e.call("isCapture")) { this.status = `inPlace waiting actor ${e.call("get_UniqueId")} to end`; return; }
    }
    const slots = q.get_field("_BossSet") as REManagedArray;
    const freeSlots: number[] = [];
    for (let i = 2; i < slots.get_size(); i++) {
      if ((slots.get_element(i) as REManagedObject).get_field("EmSetId") === -1) freeSlots.push(i);
    }
    const order = q.get_field("_BossSetNoTbl") as REManagedArray;
    if (slots.get_size() < 4 || order.get_size() < 5) throw new Error("Unexpected native boss-array capacity");
    const ids = this.plan.sequential ? this.pending.slice(0, 1) : [...this.pending];
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
        fresh.push({ id: record.call("get_EmSetId") as number, uid: record.call("get_UniqueId") as number, type });
      }
    }
    // Publish the complete group before restarting the native scheduler.
    for (let i = 2; i < order.get_size(); i++) order.call("Set", i, -1);
    fresh.forEach((entry, i) => {
      const slotNo = freeSlots[i]!;
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
    q.set_field("_BossSetCount", 2); q.set_field("_ExtraEmRno", 5);
    this.status = `inPlace native load: ${fresh.map((e) => `${e.type}/${e.uid}`).join(", ")}`;
    this.report("in-place-native-load", { token: this.plan.token, unique: this.unique, fresh, taskSlots: freeSlots.slice(0, ids.length), remaining: this.pending.length });
  }

  private scope(plan: QuestPlan): REManagedObject {
    const q = questManager();
    const stage = getSingleton("snow.stage.StageManager");
    if (!q || !stage || stage.call("get_IsQuestOnline") === true || q.call("isPlayQuest") !== true || q.call("get_ActiveQuestNo") !== plan.questId) throw new Error("inPlace requires the owned solo arena quest");
    return q;
  }
}
