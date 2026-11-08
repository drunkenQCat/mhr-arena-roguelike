import { beforeEach, describe, expect, it, vi } from "vitest";
import { NativeRuntime } from "./native_runtime";
import type { QuestInstaller } from "./quest_installer";
import { validateConfig } from "../core/config";
import { makeQuestPlan } from "../core/quest_plan";
import { RunCore } from "../core/run_core";
import { defaultConfig, monsterCatalog } from "./default_config";

const mock = vi.hoisted(() => ({
  singleton: vi.fn(), qm: vi.fn(), find: vi.fn(), hook: vi.fn(), storage: {} as Record<string, unknown>,
  dump: vi.fn(), info: vi.fn(), now: 100,
}));
vi.mock("./sdk", () => ({
  clockSeconds: () => mock.now, questManager: mock.qm, getSingleton: mock.singleton,
  findTypeDefinition: mock.find, hookMethod: mock.hook,
  PRE_HOOK: { CALL_ORIGINAL: 0, SKIP_ORIGINAL: 1 },
  reframework: { getHookStorage: () => mock.storage },
  toManagedObject: (value: unknown) => value, toPtr: (value: unknown) => value,
  toInt64: (value: unknown) => value, toFloat: (value: unknown) => value,
  floatToPtr: (value: unknown) => value,
  rejson: { dump_file: mock.dump }, relog: { info: mock.info, warn: vi.fn() },
}));

function fixture() {
  const config = validateConfig(defaultConfig);
  const core = new RunCore(config, 42);
  core.startRun(config.armorOptions[0]!);
  const wave = core.generateChoices()[0]!;
  wave.hpMul = 1.65; wave.dmgMul = 1.1;
  const plan = makeQuestPlan(config, monsterCatalog, wave, 1, 1, true);
  let questId = config.quest.id;
  const qm = { call: vi.fn((name: string) => {
    if (name === "isActiveQuest") return true;
    if (name === "get_ActiveQuestNo") return questId;
    return null;
  }) };
  mock.qm.mockReturnValue(qm);
  mock.singleton.mockImplementation((name: string) => name === "snow.stage.StageManager"
    ? { call: () => false } : null);
  const installer = { tick: vi.fn(), isInstalled: () => true, getQuest: () => null,
    getStatus: () => "ready" } as unknown as QuestInstaller;
  const runtime = new NativeRuntime(config, installer);
  runtime.tick();
  const hooks = (type: string, name: string) => {
    const entry = mock.hook.mock.calls.find((args) => args[0].key === `${type}.${name}`);
    if (!entry) throw new Error(`Missing hook ${name}`);
    return { pre: entry[1] as (...args: any[]) => any, post: entry[2] as (...args: any[]) => any };
  };
  const actor = (type: number, uid = 7) => ({
    call: (name: string) => name === "get_UniqueId" ? uid : type,
    get_field: () => null,
  });
  return { runtime, plan, qm, hooks, actor, foreign: () => { questId = 101; } };
}

beforeEach(() => {
  vi.clearAllMocks();
  mock.storage = {};
  mock.find.mockImplementation((type: string) => ({ get_method: (name: string) => ({ key: `${type}.${name}` }) }));
});

it("defers finish to native quest update, allows native failure first, and never replays or crosses quest identity", () => {
  const { runtime, qm, plan, hooks } = fixture();
  let unique = 12, status = 2;
  qm.call.mockImplementation((name: string) => name === "isActiveQuest" || name === "isPlayQuest" ? true :
    name === "get_ActiveQuestNo" ? plan.questId : name === "getActiveQuestUniqueNo" ? unique : null);
  Object.assign(qm, { get_field: () => status });
  const updated = hooks("snow.QuestManager", "update");
  runtime.finish(true);
  expect(qm.call).not.toHaveBeenCalledWith("setQuestFail", expect.anything());
  updated.post(0);
  expect(qm.call).toHaveBeenCalledWith("setQuestFail", 1);
  const failures = () => qm.call.mock.calls.filter(c => c[0] === "setQuestFail").length;
  updated.post(0); expect(failures()).toBe(1);
  runtime.finish(true); status = 4;
  updated.post(0); expect(failures()).toBe(1);
  status = 2; runtime.finish(true); unique++;
  updated.post(0); expect(failures()).toBe(1);
});

describe("native runtime hook scope", () => {
  it("blocks settlement/timeouts only while owning the prepared custom quest", () => {
    const { runtime, plan, hooks, foreign } = fixture();
    const clear = hooks("snow.QuestManager", "setQuestClear");
    const check = hooks("snow.QuestManager", "checkQuestClear");
    const over = hooks("snow.QuestManager", "isQuestTimeOver");
    expect(clear.pre()).toBe(0);
    runtime.policy(plan, true);
    expect(clear.pre()).toBe(1);
    expect(check.post(99)).toBe(0);
    expect(over.post(99)).toBe(0);
    runtime.policy(plan, false);
    expect(clear.pre()).toBe(0);
    runtime.policy(plan, true);
    foreign();
    expect(clear.pre()).toBe(0);
    expect(check.post(99)).toBe(99);
    expect(over.post(99)).toBe(99);
  });

  it("multiplies only HP/All and matching monster attack rates, never table indices", () => {
    const { runtime, plan, hooks, actor } = fixture();
    runtime.policy(plan, true);
    const hp = hooks("snow.enemy.EnemyCharacterBase", "getDifficultyRateVital");
    const attack = hooks("snow.enemy.EnemyCharacterBase", "getDifficultyRateAttack");
    const args = { 2: actor(plan.monsterIds[0]!), 3: 0, 4: 0 };
    hp.pre(args); expect(hp.post(100)).toBe(165);
    hp.pre({ ...args, 3: 1 }); expect(hp.post(100)).toBe(100);
    hp.pre({ ...args, 4: 1 }); expect(hp.post(100)).toBe(100);
    hp.pre({ ...args, 2: actor(99999) }); expect(hp.post(100)).toBe(100);
    attack.pre(args); expect(attack.post(100)).toBeCloseTo(110);
    runtime.policy(null, false);
    attack.pre(args); expect(attack.post(100)).toBe(100);
  });

  it("records kills/captures and ignores escapes and other quest actors", () => {
    const { runtime, plan, hooks, actor, foreign } = fixture();
    runtime.policy(plan, true);
    const died = hooks("snow.QuestManager", "questEnemyDie");
    died.pre({ 3: actor(plan.monsterIds[0]!, 1), 4: 0 });
    died.pre({ 3: actor(plan.monsterIds[0]!, 2), 4: 1 });
    died.pre({ 3: actor(plan.monsterIds[0]!, 3), 4: 2 });
    foreign();
    died.pre({ 3: actor(plan.monsterIds[0]!, 4), 4: 0 });
    expect(runtime.takeDeaths().map((event) => event.kind)).toEqual(["kill", "capture"]);
    expect(runtime.takeDeaths()).toEqual([]);
  });

  it("preflights capabilities before installing any hook", () => {
    mock.find.mockReturnValue({ get_method: () => null });
    const { runtime } = fixture();
    expect(runtime.ready()).toBe(false);
    expect(mock.hook).not.toHaveBeenCalled();
  });
});


it("feeds polled death evidence into the inPlace queue even without a questEnemyDie callback", () => {
  const { runtime, plan, qm } = fixture();
  runtime.policy(plan, true);
  qm.call.mockImplementation((name: string) => name === "isActiveQuest" || name === "isPlayQuest" ? true : name === "get_ActiveQuestNo" ? plan.questId : null);
  Object.assign(qm, { get_field: () => null });
  const enemy = { call: (name: string) => name === "get_UniqueId" ? 700 : name === "get_EnemyType" ? plan.monsterIds[0] : name === "isDieBehaviorActive",
    get_field: () => null };
  const manager = { call: (name: string) => name === "getBossEnemyCount" ? 1 : enemy };
  mock.singleton.mockImplementation((name: string) => name === "snow.enemy.EnemyManager" ? manager : name === "snow.stage.StageManager" ? { call: () => false } : null);
  vi.spyOn(runtime.testTools, "getHealth").mockReturnValue({ hp: 0, maxHp: 100 });
  const backend = (runtime as unknown as { inplace: { death(uid: number): void } }).inplace;
  const death = vi.spyOn(backend, "death");
  expect(runtime.read().enemies[0]?.dead).toBe(true);
  expect(death).toHaveBeenCalledWith(700);
});

it("does not capture village actors as quest players during the entry transition", () => {
  const { runtime, qm, plan } = fixture();
  let playing = true, loaded = false, elapsed = 0;
  qm.call.mockImplementation((name: string) => name === "isActiveQuest" ? true : name === "isPlayQuest" ? playing :
    name === "isEndLoadQuest" ? loaded : name === "get_ActiveQuestNo" ? plan.questId : null);
  Object.assign(qm, { get_field: (name: string) => name === "_QuestElapsedSec" ? elapsed : null });
  const player = (type: string, x: number) => ({ get_address: () => x + 10000, get_type_definition: () => ({ get_full_name: () => type }),
    get_field: () => ({x, y:50, z:47}) });
  let actors = [player("snow.player.PlayerLobbyBase", -1498), player("snow.player.LongSword", 2)];
  const pm = {get_field: () => ({get_size: () => actors.length, get_element: (i: number) => actors[i]}), call: (name: string) => name === "findMasterPlayer" ? actors[1] ?? actors[0] : true};
  mock.singleton.mockImplementation((name: string) => name === "snow.player.PlayerManager" ? pm :
    name === "snow.enemy.EnemyManager" ? {call: () => 0} : name === "snow.stage.StageManager" ? {call: () => false} : null);
  expect(runtime.read().players).toEqual([{id:1, position:{x:2,y:50,z:47}}]);
  // A task actor alone is insufficient: it can still contain the village position.
  expect(runtime.read().entryReady).toBe(false);
  loaded = true;
  expect(runtime.read().entryReady).toBe(false);
  elapsed = 1;
  expect(runtime.read().entryReady).toBe(true);
  loaded = false;
  expect(runtime.read().entryReady).toBe(false);
  actors = [player("snow.player.PlayerLobbyBase", -1498)];
  expect(runtime.read().players).toEqual([]);
  playing = false;
  expect(runtime.read().players).toHaveLength(1);
  actors = [player("snow.player.LongSword", NaN)];
  expect(runtime.read().players).toEqual([]);
});

it("discards a queued native finish when its runtime is detached", () => {
  const {runtime, qm, plan, hooks} = fixture();
  qm.call.mockImplementation((name: string) => name === "isActiveQuest" || name === "isPlayQuest" ? true :
    name === "get_ActiveQuestNo" ? plan.questId : name === "getActiveQuestUniqueNo" ? 12 : null);
  Object.assign(qm, {get_field: () => 2});
  runtime.finish(true); runtime.shutdown(); hooks("snow.QuestManager", "update").post(0);
  expect(qm.call.mock.calls.some(c => c[0] === "setQuestFail")).toBe(false);
});


it("does not release completed native objectives before an owned failure has been processed", () => {
 const {runtime,qm,plan,hooks,foreign}=fixture();let status=2;
 qm.call.mockImplementation((n:string)=>n==="isActiveQuest"||n==="isPlayQuest"?true:n==="get_ActiveQuestNo"?plan.questId:n==="getActiveQuestUniqueNo"?12:null);
 Object.assign(qm,{get_field:()=>status});runtime.policy(plan,true);
 runtime.policy(null,false);runtime.finish(true);
 const clear=hooks("snow.QuestManager","setQuestClear"), check=hooks("snow.QuestManager","checkQuestClear");
 expect(clear.pre()).toBe(1);expect(check.post(1)).toBe(0);
 hooks("snow.QuestManager","update").post(0);expect(qm.call).toHaveBeenCalledWith("setQuestFail",1);
 status=4;expect(clear.pre()).toBe(1);
 qm.call.mockImplementation((n:string)=>n==="get_ActiveQuestNo"?101:n==="getActiveQuestUniqueNo"?13:true);
 expect(clear.pre()).toBe(0);
});
