import { beforeEach, expect, it, vi } from "vitest";
import { TestTools } from "./test_tools";
const mock = vi.hoisted(() => ({ singleton: vi.fn(), qm: vi.fn(), find: vi.fn(), hook: vi.fn(), now: 100 }));
vi.mock("./sdk", () => ({ clockSeconds: () => mock.now, getSingleton: mock.singleton, questManager: mock.qm,
  findTypeDefinition: mock.find, hookMethod: mock.hook, toManagedObject: (v: unknown) => v,
  toPtr: (v: unknown) => v, PRE_HOOK: { CALL_ORIGINAL: 0, SKIP_ORIGINAL: 1 } }));
beforeEach(() => { vi.clearAllMocks(); mock.now = 100; });
function fixture() {
  const state = { id: 900102, online: false, playing: true, nativeUpdate: false, hp: 100, dead: false };
  const report = vi.fn();
  const vital = { call: vi.fn((name: string) => {
    if (!state.nativeUpdate) throw Error("DeviceContext unavailable outside native update");
    return name === "get_Current" ? state.hp : 100;
  }) };
  const enemy = { get_field: () => ({ call: () => vital }), call: vi.fn((name: string) => {
    if (name === "get_UniqueId") return 7;
    if (name === "isDieBehaviorActive") return state.dead;
    if (name === "stockDirectForceKillDamage") { state.hp = 0; state.dead = true; }
    return false;
  }) };
  mock.qm.mockReturnValue({ call: (n: string) => n === "get_ActiveQuestNo" ? state.id
    : n === "getActiveQuestUniqueNo" ? 12 : state.playing });
  mock.singleton.mockImplementation((n: string) => n === "snow.stage.StageManager" ? { call: () => state.online }
    : n === "snow.enemy.EnemyManager" ? { call: (m: string) => m === "getBossEnemyCount" ? 1 : enemy } : null);
  mock.find.mockImplementation((t: string) => ({ get_method: (n: string) => ({ key: `${t}.${n}` }) }));
  const tools = new TestTools(report);
  const hook = (type: string, method: string) => mock.hook.mock.calls.find(([m]) => m.key === `${type}.${method}`)!;
  const update = () => {
    state.nativeUpdate = true;
    hook("snow.enemy.EnemyCharacterBase", "update")[1]({ 2: enemy });
    state.nativeUpdate = false;
  };
  return { tools, state, enemy, vital, report, hook, update };
}
it("reads DVE HP and requests lethal damage only inside native enemy update, once per click", () => {
  const { tools, vital, enemy, update, report } = fixture();
  tools.tick(); expect(vital.call).not.toHaveBeenCalled();
  update(); expect(tools.getHealth(7)?.hp).toBe(100);
  tools.requestKill(); tools.tick();
  expect(enemy.call).not.toHaveBeenCalledWith("stockDirectForceKillDamage");
  update(); update(); tools.tick();
  expect(enemy.call.mock.calls.filter(([n]) => n === "stockDirectForceKillDamage")).toHaveLength(1);
  expect(tools.getHealth(7)?.hp).toBe(0);
  expect(report).toHaveBeenCalledWith("test-kill", expect.objectContaining({ uid: 7 }));
});
it("invincibility and lethal damage leave online and unrelated quests alone; reset releases protection", () => {
  const { tools, state, hook, update, enemy } = fixture();
  tools.tick(); tools.toggleGod();
  const block = hook("snow.player.PlayerQuestBase", "damageVital")[1];
  const check = hook("snow.player.PlayerQuestBase", "checkMuteki")[2];
  expect(block()).toBe(1); expect(check(0)).toBe(1);
  state.online = true; expect(block()).toBe(0); expect(check(0)).toBe(0);
  tools.requestKill(); tools.tick(); update();
  expect(enemy.call).not.toHaveBeenCalledWith("stockDirectForceKillDamage");
  state.online = false; state.id = 101; expect(block()).toBe(0);
  state.id = 900102; tools.shutdown(); expect(block()).toBe(0);
});
