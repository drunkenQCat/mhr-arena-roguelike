/** Native BOSSRUSH data writer. Owns every mutated array; never calls a spawn API. */
import type { RogueConfig } from "../core/config";
import { normalPatch, ultimateVitalTbl, type QuestPlan } from "../core/quest_plan";
import { snow_quest_QuestType } from "./gen/enums/snow_quest_QuestType";
import { snow_QuestManager_BossSetCondition } from "./gen/enums/snow_QuestManager_BossSetCondition";
import { snow_quest_QuestTargetType } from "./gen/enums/snow_quest_QuestTargetType";
import {
  createInstance, createManagedArray, createManagedString, findTypeDefinition, hookMethod,
  PRE_HOOK, questManager, reframework, relog, rejson, retain, toInt64, toManagedObject, toPtr,
  type REManagedArray, type REManagedObject,
} from "./sdk";

const MARKER = "MhwRogue_BossRush_v2";
const TEXT: Record<number, string> = {
  0: "Arena Roguelike / 斗技场肉鸽", 1: "Arena Research",
  2: "BOSSRUSH roguelike. Bring your equipment. Return to the starting point after carving.",
  3: "Hunt the wave targets", 4: "Run ends when the cart allowance is exhausted",
};

export class QuestInstaller {
  private quest: REManagedObject | null = null;
  private normal: REManagedObject | null = null;
  private retained: REManagedObject[] = [];
  private hooks = false;
  private ticks = 0;
  private status = "Waiting for the village quest catalogue";
  private stopped = false;
  private currentPlan: QuestPlan | null = null;

  constructor(private readonly cfg: RogueConfig, private readonly initialPlan: QuestPlan) {}
  getStatus(): string { return this.status; }
  isInstalled(): boolean { return this.quest !== null && !this.stopped; }
  getQuest(): REManagedObject | null { return this.quest; }
  getPlan(): QuestPlan | null { return this.currentPlan; }

  tick(): void {
    if (this.quest || this.stopped || ++this.ticks % 120 !== 0) return;
    try {
      const qm = questManager();
      if (!qm || qm.call("isActiveQuest")) return;
      const dict = qm.get_field("_QuestDataDictionary") as REManagedObject | null;
      if (!dict || !dict.call("ContainsKey", this.cfg.quest.baseId)) return;
      this.publish(this.initialPlan, false);
    } catch (error) {
      this.stopped = true;
      this.status = `Install failed: ${String(error)}`;
      relog.error(`[MhwRogue] ${this.status}`);
    }
  }

  private clone(original: REManagedObject, pool: REManagedObject[]): REManagedObject {
    const td = original.get_type_definition();
    const instance = createInstance(td.get_full_name(), true);
    if (!instance) throw new Error(`Cannot allocate ${td.get_full_name()}`);
    const copy = retain(instance, pool);
    for (const field of td.get_fields()) {
      if (field.is_static()) continue;
      const name = field.get_name();
      const type = field.get_type().get_full_name();
      const value = original.get_field(name);
      if (value !== null && value !== undefined && type.endsWith("[]")) {
        const source = value as REManagedArray;
        const array = retain(createManagedArray(type.slice(0, -2), source.get_size()), pool);
        for (let i = 0; i < source.get_size(); i++) array.call("Set", i, source.call("Get", i));
        copy.set_field(name, array);
      } else copy.set_field(name, value);
    }
    return copy;
  }

  private enemy: REManagedObject | null = null;

  /** 极强单怪：把模板最高难度档重排到首槽（ultimateVitalTbl；其余 tier 不动）。 */
  private applyEnemyVitals(enemy: REManagedObject, plan: QuestPlan): void {
    const current = enemy.get_field("_VitalTbl") as REManagedArray | null;
    if (!current) return;
    const template: number[] = [];
    const size = current.get_size();
    for (let i = 0; i < size; i++) template.push(current.call("Get", i) as number);
    const reordered = ultimateVitalTbl(template, plan.wave.tier, plan.monsterIds.length);
    if (!reordered) return;
    for (let i = 0; i < size; i++) current.call("Set", i, reordered[i] ?? 0);
    relog.info(`[MhwRogue] 极强单怪难度档重排：_VitalTbl ${template.join("/")} → ${reordered.join("/")}`);
  }

  private patch(normal: REManagedObject, plan: QuestPlan): void {
    const patch = normalPatch(plan, snow_QuestManager_BossSetCondition.DEFAULT,
      snow_QuestManager_BossSetCondition.EM1_HP, snow_quest_QuestType.BOSSRUSH,
      snow_quest_QuestTargetType.AllMainEnemy);
    for (const name of Object.keys(patch)) {
      const value = patch[name];
      if (Array.isArray(value)) {
        const array = normal.get_field(name) as REManagedArray;
        if (!array || array.get_size() < value.length) throw new Error(`Unexpected native array ${name}`);
        for (let i = 0; i < array.get_size(); i++) array.call("Set", i, value[i] ?? 0);
      } else normal.set_field(name, value);
    }
  }

  publish(plan: QuestPlan, inPlace: boolean): void {
    if (plan.questId !== this.cfg.quest.id || plan.baseId !== this.cfg.quest.baseId) throw new Error("Quest plan/config mismatch");
    const qm = questManager();
    if (!qm) throw new Error("Quest manager unavailable");
    if (inPlace) {
      if (!this.normal || !this.quest || qm.call("get_ActiveQuestNo") !== plan.questId || !qm.call("isPlayQuest")) {
        throw new Error("Cannot patch an unrelated or inactive quest");
      }
      this.patch(this.normal, plan);
      if (this.enemy) this.applyEnemyVitals(this.enemy, plan);
      this.currentPlan = plan;
      this.status = `In-place table published for layer ${plan.layer} (spawn behavior unverified)`;
      return;
    }
    if (qm.call("isActiveQuest")) throw new Error("Cancel/finish the accepted quest before changing its table");
    const dict = qm.get_field("_QuestDataDictionary") as REManagedObject;
    if (!dict || !dict.call("ContainsKey", plan.baseId)) throw new Error(`Missing BOSSRUSH template ${plan.baseId}`);
    if (dict.call("ContainsKey", plan.questId)) {
      const existing = toManagedObject(dict.call("get_Item", plan.questId)).call("get_RawNormal") as REManagedObject;
      if (existing.get_field("_DbgName") !== MARKER) throw new Error(`Quest ID collision: ${plan.questId}`);
    }
    const source = qm.call("getQuestData(System.Int32)", plan.baseId) as REManagedObject;
    const sourceNormal = source.call("get_RawNormal") as REManagedObject;
    if (((sourceNormal.get_field("_QuestType") as number) & snow_quest_QuestType.BOSSRUSH) === 0 ||
        sourceNormal.get_field("_MapNo") !== plan.mapNo) throw new Error("Template is not an arena BOSSRUSH");
    const next: REManagedObject[] = [];
    let committed = false;
    try {
      const normal = this.clone(sourceNormal, next);
      const enemy = this.clone(source.call("get_RawEnemy") as REManagedObject, next);
      this.patch(normal, plan);
      enemy.set_field("_QuestNo", plan.questId);
      this.applyEnemyVitals(enemy, plan);
      // Preserve enemy _EmsSetNo, route/init names and difficulty table INDICES.
      const allocated = createInstance("snow.quest.QuestData", true);
      if (!allocated) throw new Error("Cannot allocate QuestData");
      const quest = retain(allocated, next);
      quest.call("set_RawNormal", normal);
      quest.call("set_RawEnemy", enemy);
      this.installHooks();
      dict.call("set_Item", plan.questId, quest);
      const previous = this.retained;
      this.quest = quest;
      this.normal = normal;
      this.enemy = enemy;
      this.retained = next;
      this.currentPlan = plan;
      this.stopped = false;
      committed = true;
      for (const object of previous) object.release();
      this.status = `Quest ${plan.questId}: layer ${plan.layer}, monsters ${plan.monsterIds.join(" / ")}`;
      relog.info(`[MhwRogue] ${this.status}`);
      rejson.dump_file("mhw_rogue_install.json", { installed: true, backend: "BOSSRUSH", plan,
        template: plan.baseId, timeLimit: 0, departure_verified: false, spawn_verified: false }, 2);
    } finally {
      if (!committed) for (const object of next) object.release();
    }
  }

  private installHooks(): void {
    if (this.hooks) return;
    const text = findTypeDefinition("snow.quest.QuestData")?.get_method("getQuestTextCore");
    const list = findTypeDefinition("snow.QuestManager")?.get_method("makeQuestNoList");
    if (!text || !list) throw new Error("Missing quest text/list methods");
    hookMethod(text, (args) => {
      const storage = reframework.getHookStorage();
      storage.mhw_rogue_text_v2 = null;
      if (this.quest && args[2] === toPtr(this.quest)) {
        const replacement = TEXT[toInt64(args[3])];
        if (replacement) {
          storage.mhw_rogue_text_v2 = replacement;
          return PRE_HOOK.SKIP_ORIGINAL;
        }
      }
      return PRE_HOOK.CALL_ORIGINAL;
    }, (retval) => {
      const value = reframework.getHookStorage().mhw_rogue_text_v2;
      return value ? toPtr(createManagedString(value as string)) : retval;
    });
    hookMethod(list, () => {}, (retval) => {
      const values = toManagedObject(retval);
      if (this.quest && values && values.call("Contains", 101) && !values.call("Contains", this.cfg.quest.id)) {
        values.call("Add", this.cfg.quest.id);
      }
      return retval;
    });
    this.hooks = true;
  }
}
