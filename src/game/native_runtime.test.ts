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
    get_field: () => type,
    call: (name: string) => name === "get_UniqueId" ? uid : type,
  });
  return { runtime, plan, qm, hooks, actor, foreign: () => { questId = 101; } };
}

beforeEach(() => {
  vi.clearAllMocks();
  mock.storage = {};
  mock.find.mockImplementation((type: string) => ({ get_method: (name: string) => ({ key: `${type}.${name}` }) }));
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
