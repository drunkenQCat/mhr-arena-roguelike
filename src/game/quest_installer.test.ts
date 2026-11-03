import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QuestInstaller } from "./quest_installer";
import { validateConfig } from "../core/config";
import { makeQuestPlan } from "../core/quest_plan";
import { RunCore } from "../core/run_core";
import { defaultConfig, monsterCatalog } from "./default_config";

const mock = vi.hoisted(() => ({ qm: vi.fn(), create: vi.fn(), array: vi.fn(), hook: vi.fn(), find: vi.fn(), storage: {} }));
vi.mock("./sdk", () => ({
  questManager: mock.qm, createInstance: mock.create, createManagedArray: mock.array,
  createManagedString: (value: unknown) => value, toPtr: (value: unknown) => value,
  toManagedObject: (value: unknown) => value, toInt64: (value: unknown) => value,
  retain: (object: any, pool: any[]) => { object.add_ref(); pool.push(object); return object; },
  findTypeDefinition: mock.find, hookMethod: mock.hook,
  PRE_HOOK: { CALL_ORIGINAL: 0, SKIP_ORIGINAL: 1 },
  reframework: { getHookStorage: () => mock.storage },
  relog: { info: vi.fn(), error: vi.fn() }, rejson: { dump_file: vi.fn() },
}));

class NativeObject {
  refs = 0;
  constructor(readonly type: string, readonly fields: Record<string, any> = {}) {}
  get_field(name: string) { return this.fields[name]; }
  set_field(name: string, value: any) { this.fields[name] = value; }
  add_ref() { this.refs++; }
  release() { this.refs--; }
  get_address() { return this; }
  get_type_definition(): any {
    return { get_full_name: () => this.type, get_fields: () => Object.entries(this.fields).map(([name, value]) => ({
      get_name: () => name, is_static: () => false,
      get_type: () => ({ get_full_name: () => value instanceof NativeArray ? `${value.elementType}[]` : "System.Int32" }),
    })) };
  }
  call(name: string, ...args: any[]): any {
    if (name === "get_RawNormal") return this.fields.normal;
    if (name === "get_RawEnemy") return this.fields.enemy;
    if (name === "set_RawNormal") { this.fields.normal = args[0]; return; }
    if (name === "set_RawEnemy") { this.fields.enemy = args[0]; return; }
    throw Error(`Unexpected call ${name}`);
  }
}
class NativeArray extends NativeObject {
  constructor(readonly elementType: string, readonly elements: any[]) { super(`${elementType}[]`); }
  get_size() { return this.elements.length; }
  get_element(index: number) { return this.elements[index]; }
  override call(name: string, ...args: any[]): any {
    if (name === "Get") return this.elements[args[0]];
    if (name === "Set") { this.elements[args[0]] = args[1]; return; }
    return super.call(name, ...args);
  }
}

function fixture() {
  const config = validateConfig(defaultConfig);
  const core = new RunCore(config, 42);
  core.startRun(config.armorOptions[0]!);
  const wave = core.generateChoices().find((option) => option.monsters.length === 2)!;
  const plan = makeQuestPlan(config, monsterCatalog, wave, 1, 1, true);
  const reference = JSON.parse(readFileSync(new URL("../../data/bossrush_reference.json", import.meta.url), "utf8")).base;
  const convert = (fields: Record<string, any>) => Object.fromEntries(Object.entries(fields).map(([name, value]) =>
    [name, Array.isArray(value) ? new NativeArray(typeof value[0] === "string" ? "System.String" : "System.Int32", value.slice()) : value]));
  const normal = new NativeObject("normal", convert(reference.normal));
  const enemy = new NativeObject("enemy", convert(reference.enemy));
  const source = new NativeObject("quest", { normal, enemy });
  const dictionary = new Map<number, NativeObject>([[603, source]]);
  const dict = { call: (name: string, id: number, value?: NativeObject) => {
    if (name === "ContainsKey") return dictionary.has(id);
    if (name === "get_Item") return dictionary.get(id);
    if (name === "set_Item") dictionary.set(id, value!);
  } };
  let active = false;
  const qm = { get_field: () => dict, call: (name: string, id?: number) => {
    if (name === "isActiveQuest") return active;
    if (name === "isPlayQuest") return active;
    if (name === "get_ActiveQuestNo") return config.quest.id;
    if (name === "getQuestData(System.Int32)") return dictionary.get(id!);
    throw Error(name);
  } };
  mock.qm.mockReturnValue(qm);
  mock.create.mockImplementation((type: string) => new NativeObject(type));
  mock.array.mockImplementation((type: string, length: number) => new NativeArray(type, Array(length).fill(0)));
  mock.find.mockReturnValue({ get_method: (name: string) => ({ name }) });
  return { config, plan, normal, enemy, dictionary,
    installer: new QuestInstaller(config, plan), play: () => { active = true; } };
}

beforeEach(() => vi.clearAllMocks());
describe("native BOSSRUSH writer", () => {
  it("deep-clones all arrays, updates targets, and preserves native difficulty table indices", () => {
    const { plan, installer, normal, enemy, dictionary } = fixture();
    installer.publish(plan, false);
    const copy = dictionary.get(plan.questId)!.fields.normal as NativeObject;
    for (const [name, value] of Object.entries(normal.fields)) {
      if (value instanceof NativeArray) expect(copy.fields[name]).not.toBe(value);
    }
    expect(copy.fields._BossEmType.elements).toEqual([...plan.monsterIds, 0, 0, 0, 0, 0]);
    expect(normal.fields._BossEmType.elements.slice(0, 3)).toEqual([23, 118, 89]);
    expect(copy.fields._TgtNum.elements).toEqual([2, 0]);
    expect(copy.fields._BossSetParam.elements).toEqual([0, 0, 0, 0, 0, 0, 0]);
    const enemyCopy = dictionary.get(plan.questId)!.fields.enemy as NativeObject;
    expect(enemyCopy.fields._VitalTbl.elements).toEqual(enemy.fields._VitalTbl.elements);
    expect(enemyCopy.fields._VitalTbl).not.toBe(enemy.fields._VitalTbl);
    expect(enemyCopy.fields._RouteNo.elements).toEqual([10, 10, 10, 0, 0, 0, 0]);
  });

  it("does not replace the installed quest if allocation fails during preparation", () => {
    const { plan, installer, dictionary } = fixture();
    installer.publish(plan, false);
    const installed = dictionary.get(plan.questId);
    mock.array.mockImplementationOnce(() => { throw Error("allocation failed"); });
    expect(() => installer.publish({ ...plan, token: 2 }, false)).toThrow("allocation failed");
    expect(dictionary.get(plan.questId)).toBe(installed);
    expect(installer.getPlan()?.token).toBe(1);
  });

  it("rejects ID collisions and accepted-quest replacement", () => {
    const { plan, installer, dictionary, play } = fixture();
    dictionary.set(plan.questId, new NativeObject("quest", { normal: new NativeObject("normal", { _DbgName: "other mod" }) }));
    expect(() => installer.publish(plan, false)).toThrow("collision");
    dictionary.delete(plan.questId); play();
    expect(() => installer.publish(plan, false)).toThrow("accepted quest");
  });
});

it("initializes reused slots from real boss parameters, including resized init-name arrays",()=>{
 const f=fixture();f.installer.publish(f.plan,false);f.play();
 const live=f.dictionary.get(f.plan.questId)!.fields.enemy;
 f.installer.prepareInplaceSlot(f.plan,3,92,119);
 for(const field of ["_VitalTbl","_AttackTbl","_Scale","_ScaleTbl","_RouteNo","_InitSetName"])
  expect(live.fields[field].elements[119]).toBe(f.enemy.fields[field].elements[0]);
 expect(f.enemy.fields._VitalTbl.elements[3]).toBe(0);
 const ultimate={...f.plan,wave:{...f.plan.wave,tier:"ultimate" as const}};
 f.installer.prepareInplaceSlot(ultimate,2,1369);
 expect(live.fields._VitalTbl.elements[2]).toBe(80);
 f.installer.prepareInplaceSlot(f.plan,2,92);
 expect(live.fields._VitalTbl.elements[2]).toBe(68);
});

it("keeps hub rank and enemy level for the independent multiplayer entry table", () => {
  const f = fixture();
  const cfg = { ...f.config, quest: { ...f.config.quest, id: 900103 } };
  const plan = { ...f.plan, questId: 900103 };
  const installer = new QuestInstaller(cfg, plan, true);
  installer.publish(plan, false);
  const copy = f.dictionary.get(900103)!.fields.normal;
  expect(copy.fields._QuestLv).toBe(f.normal.fields._QuestLv);
  expect(copy.fields._EnemyLv).toBe(f.normal.fields._EnemyLv);
  expect(copy.fields._TimeLimit).toBe(50);
  expect(f.dictionary.has(900102)).toBe(false);
});

it("overrides single-quest classification only for the installed entry quest", () => {
  const f = fixture();
  const cfg = { ...f.config, quest: { ...f.config.quest, id: 900103 } };
  const installer = new QuestInstaller(cfg, { ...f.plan, questId: 900103 }, true);
  installer.publish({ ...f.plan, questId: 900103 }, false);
  const hook = mock.hook.mock.calls.find((args) => args[0].name === "isSingleQuest(System.Int32)")!;
  hook[1]({ 2: 900103 }); expect(hook[2](1)).toBe(0);
  const active = mock.hook.mock.calls.find((args) => args[0].name === "isSingleQuest")!;
  let activeId = 900103;
  const manager = { get_field: () => ({ get_field: () => activeId }) };
  active[1]({ 2: manager }); expect(active[2](1)).toBe(0);
  activeId = 10107;
  active[1]({ 2: manager }); expect(active[2](1)).toBe(1);
  for (const id of [101, 603, 900102]) {
    hook[1]({ 2: id }); expect(hook[2](1)).toBe(1);
  }
  const hall = mock.hook.mock.calls.find((args) => args[0].name === "isHallCounterQuest(System.Int32)")!;
  hall[1]({ 2: 900103 }); expect(hall[2](0)).toBe(1);
  for (const id of [101, 603, 900102]) {
    hall[1]({ 2: id }); expect(hall[2](0)).toBe(0);
    hall[1]({ 2: id }); expect(hall[2](1)).toBe(1);
  }
  const village = mock.hook.mock.calls.find((args) => args[0].name === "isVillageCounterQuest(System.Int32)")!;
  village[1]({ 2: 900103 }); expect(village[2](1)).toBe(0);
  for (const id of [101, 603, 10107, 900102]) {
    village[1]({ 2: id }); expect(village[2](1)).toBe(1);
    village[1]({ 2: id }); expect(village[2](0)).toBe(0);
  }
  const first = installer.multiplayerDescriptor();
  f.dictionary.get(900103)!.fields.enemy.fields._VitalTbl.elements[0]++;
  expect(installer.multiplayerDescriptor()).not.toBe(first);
});
