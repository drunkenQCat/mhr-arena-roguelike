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
const MAX_NATIVE_PARAMETER_ENTRIES = 512;
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

  constructor(private readonly cfg: RogueConfig, private readonly initialPlan: QuestPlan,
    private readonly multiplayerEntry = false) {}
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
    if (this.multiplayerEntry) {
      // Keep the native hub template rank; the solo patch intentionally sets Village rank.
      const template = questManager()?.call("getQuestData(System.Int32)", plan.baseId) as REManagedObject | null;
      const raw = template?.call("get_RawNormal") as REManagedObject | null;
      if (!raw) throw new Error("Multiplayer template unavailable");
      patch._QuestLv = raw.get_field("_QuestLv");
      patch._EnemyLv = raw.get_field("_EnemyLv");
      patch._TimeLimit = 50;
    }
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

  /** Populate every reused task slot from a real template boss, never its zero tail.
   * getQuestEnemyNando indexes these arrays directly by EmSetId (native read
   * uses r13 = emSetId with no bounds check), not by reusable task slot. */
  prepareInplaceSlot(plan: QuestPlan, slot: number, type: number, emSetId = slot): void {
    if (!Number.isInteger(emSetId) || emSetId < 0 || emSetId >= MAX_NATIVE_PARAMETER_ENTRIES) throw new Error("Invalid native enemy parameter index");
    const qm = questManager();
    if (!qm || !this.enemy || !this.normal || qm.call("get_ActiveQuestNo") !== plan.questId || !qm.call("isPlayQuest")) throw new Error("Cannot configure an unrelated inPlace slot");
    const source = (qm.call("getQuestData(System.Int32)", plan.baseId) as REManagedObject).call("get_RawEnemy") as REManagedObject;
    for (const name of ["_VitalTbl", "_AttackTbl", "_PartsTbl", "_OtherTbl", "_StaminaTbl", "_Scale", "_ScaleTbl", "_Difficulty", "_BossMulti", "_IndividualType", "_SubType", "_RouteNo", "_InitSetName"]) {
      const base = source.get_field(name) as REManagedArray;
      let target = this.enemy.get_field(name) as REManagedArray;
      if (!base || !target) throw new Error(`Missing boss parameter array ${name}`);
      if (target.get_size() <= emSetId) {
        // Old arrays stay retained until quest teardown: native readers can still
        // hold them. Doubling bounds the sum of those old capacities instead of
        // retaining another nearly identical array for every newly assigned ID.
        let capacity = Math.max(16, target.get_size());
        while (capacity <= emSetId) capacity = Math.min(MAX_NATIVE_PARAMETER_ENTRIES, capacity * 2);
        const expanded = retain(createManagedArray(target.get_type_definition().get_full_name().slice(0, -2), capacity), this.retained);
        for (let i = 0; i < capacity; i++) expanded.call("Set", i, i < target.get_size() ? target.call("Get", i) : base.call("Get", 0));
        this.enemy.set_field(name, expanded); target = expanded;
      }
      let value = base.call("Get", 0);
      if (name === "_VitalTbl" && plan.wave.tier === "ultimate") {
        for (let i = 1; i < base.get_size(); i++) value = Math.max(value as number, base.call("Get", i) as number);
      }
      target.call("Set", emSetId, value);
    }
    (this.normal.get_field("_BossEmType") as REManagedArray).call("Set", slot, type);
    this.currentPlan = plan;
    this.status = `In-place layer ${plan.layer}: slot ${slot}, monster ${type}`;
  }

  /** Deterministic readback of both native tables, including template defaults.
   * No pointers or object addresses may enter a cross-machine fingerprint. */
  multiplayerDescriptor(): string {
    if (!this.multiplayerEntry || !this.normal || !this.enemy) throw new Error("Multiplayer table not prepared");
    const scalar = (value: unknown): string => {
      if (value === null || value === undefined) return "null";
      if (!["number", "string", "boolean"].includes(typeof value)) throw new Error("Unsupported native field in multiplayer fingerprint");
      const text = String(value); return `${typeof value}:${text.length}:${text}`;
    };
    const parts: string[] = ["mhr-entry-native-v2"];
    for (const object of [this.normal, this.enemy]) {
      const fields = object.get_type_definition().get_fields().filter((f) => !f.is_static());
      fields.sort((a, b) => a.get_name() < b.get_name() ? -1 : a.get_name() > b.get_name() ? 1 : 0);
      for (const field of fields) {
        const name = field.get_name(), value = object.get_field(name);
        parts.push(name);
        if (value !== null && value !== undefined && field.get_type().get_full_name().endsWith("[]")) {
          const array = value as REManagedArray;
          parts.push(`array:${array.get_size()}`);
          for (let i = 0; i < array.get_size(); i++) parts.push(scalar(array.call("Get", i)));
        } else parts.push(scalar(value));
      }
    }
    return parts.join("|");
  }

  private installHooks(): void {
    if (this.hooks) return;
    const text = findTypeDefinition("snow.quest.QuestData")?.get_method("getQuestTextCore");
    const list = findTypeDefinition("snow.QuestManager")?.get_method("makeQuestNoList");
    const single = this.multiplayerEntry ? findTypeDefinition("snow.quest.QuestUtility")?.get_method("isSingleQuest(System.Int32)") : null;
    const hall = this.multiplayerEntry ? findTypeDefinition("snow.quest.QuestUtility")?.get_method("isHallCounterQuest(System.Int32)") : null;
    const village = this.multiplayerEntry ? findTypeDefinition("snow.quest.QuestUtility")?.get_method("isVillageCounterQuest(System.Int32)") : null;
    const activeSingle = this.multiplayerEntry ? findTypeDefinition("snow.QuestManager")?.get_method("isSingleQuest") : null;
    if (!text || !list || (this.multiplayerEntry && (!single || !hall || !village || !activeSingle))) throw new Error("Missing quest text/list/multiplayer classification methods");
    hookMethod(text, (args) => {
      const storage = reframework.getHookStorage();
      storage.mhw_rogue_text_v2 = null;
      if (this.quest && args[2] === toPtr(this.quest)) {
        const textId = toInt64(args[3]);
        const replacement = this.multiplayerEntry && textId === 0
          ? "MP ENTRY TEST / 联机入场测试" : TEXT[textId];
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
      if (this.quest && values && values.call("Contains", this.multiplayerEntry ? this.cfg.quest.baseId : 101) && !values.call("Contains", this.cfg.quest.id)) {
        values.call("Add", this.cfg.quest.id);
      }
      return retval;
    });
    if (this.multiplayerEntry) {
      // getMaxJoinNum checks village classification independently of the hall and
      // single-player checks. Let the native capacity calculation return four.
      hookMethod(village!, (args) => {
        reframework.getHookStorage().mhr_entry_village = !!this.quest && toInt64(args[2]) === this.cfg.quest.id;
        return PRE_HOOK.CALL_ORIGINAL;
      }, (retval) => reframework.getHookStorage().mhr_entry_village ? toPtr(0) : retval);
      // QuestManager has its own native classification implementation; changing
      // QuestUtility alone does not cover the active quest's single-player check.
      hookMethod(activeSingle!, (args) => {
        const identifier = toManagedObject(args[2]).get_field("_QuestIdentifier") as REManagedObject | null;
        reframework.getHookStorage().mhr_entry_active_single = !!this.quest && identifier?.get_field("_QuestNo") === this.cfg.quest.id;
        return PRE_HOOK.CALL_ORIGINAL;
      }, (retval) => reframework.getHookStorage().mhr_entry_active_single ? toPtr(0) : retval);
      hookMethod(single!, (args) => {
        reframework.getHookStorage().mhr_entry_single = !!this.quest && toInt64(args[2]) === this.cfg.quest.id;
        return PRE_HOOK.CALL_ORIGINAL;
      }, (retval) => reframework.getHookStorage().mhr_entry_single ? toPtr(0) : retval);
      // Native hall membership is an independent quest-number classification.
      // Returning false from isSingleQuest alone does not make 900103 a hall quest.
      hookMethod(hall!, (args) => {
        reframework.getHookStorage().mhr_entry_hall = !!this.quest && toInt64(args[2]) === this.cfg.quest.id;
        return PRE_HOOK.CALL_ORIGINAL;
      }, (retval) => reframework.getHookStorage().mhr_entry_hall ? toPtr(1) : retval);
    }
    this.hooks = true;
  }
}
