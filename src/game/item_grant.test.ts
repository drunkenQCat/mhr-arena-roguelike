import { beforeEach, describe, expect, it, vi } from "vitest";
const host = vi.hoisted(() => ({ count: 2, add: true, active: false, online: false, playing: true, questId: 900102, unique: 42, live: false, throwAfter: false,
  readBroken: false, capacity: true, writes: 0, methodAvailable: true, args: [] as unknown[] }));
vi.mock("./sdk", () => ({
  getSingleton: (name: string) => {
    if (name === "snow.QuestManager") return { call: (m: string) => m === "isActiveQuest" ? host.active : m === "isPlayQuest" ? host.playing : m === "get_ActiveQuestNo" ? host.questId : m === "getActiveQuestUniqueNo" ? host.unique : null };
    if (name === "snow.enemy.EnemyManager") return { call: (m: string) => m === "getBossEnemyCount" ? 1 : { call: (method: string) => method === "isDieBehaviorActive" && !host.live } };
    if (name === "snow.stage.StageManager") return { call: () => host.online };
    if (name === "snow.gui.GuiManager") return { call: (m: string) => m === "IsCanInvokeQuestBoard" };
    if (name === "snow.data.DataManager") return { get_field: () => ({
      get_type_definition: () => ({ get_method: (name: string) =>
        host.methodAvailable && name === "tryAddGameItem(snow.data.ContentsIdSystem.ItemId, System.Int32)" ? {} : null }),
      call: (m: string, ...args: unknown[]) => {
      if (m === "canAddItem") return host.capacity;
      if (m === "findInventoryData") {
        if (host.readBroken) throw new Error("count unavailable");
        return host.count === 0 ? null : { call: () => host.count };
      }
      // Bare-name lookup returns another overload and silently does nothing, as in the game log.
      if (m === "tryAddGameItem(snow.data.ContentsIdSystem.ItemId, System.Int32)") {
        host.args = args;
        host.writes++;
        if (host.add) host.count++;
        if (host.throwAfter) { host.readBroken = true; throw new Error("native failed after write"); }
      }
    } }) };
    return null;
  },
  relog: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
import { grantItem } from "./item_grant";

beforeEach(() => Object.assign(host, { count: 2, add: true, active: false, online: false,
  playing: true, questId: 900102, unique: 42, live: false, throwAfter: false, readBroken: false, capacity: true, writes: 0, methodAvailable: true, args: [] }));
describe("native delivery confirmation", () => {
  it("does not mistake a void no-op for successful delivery", () => {
    host.add = false;
    expect(grantItem("potion", 1)).toMatchObject({ granted: false, before: 2, after: 2, uncertain: false });
  });
  it("requires exactly one item to be observed in the pouch", () => {
    expect(grantItem("potion", 1)).toMatchObject({ granted: true, before: 2, after: 3 });
    expect(host.args).toEqual([68157446, 1]);
  });
  it("uses the explicit overload for the first item in an empty stack", () => {
    host.count = 0;
    expect(grantItem("dust_life", 1)).toMatchObject({ granted: true, before: 0, after: 1 });
    expect(host.args).toEqual([68157449, 1]);
  });
  it("does not fall back to ambiguous dispatch when the exact overload is missing", () => {
    host.methodAvailable = false;
    expect(grantItem("potion", 1)).toMatchObject({ granted: false,
      reason: "Required two-argument native overload is unavailable" });
    expect(host.writes).toBe(0);
  });
  it("rejects accepted quests, online play, full pouch and non-unit requests before mutation", () => {
    host.active = true; expect(grantItem("potion", 1).granted).toBe(false);
    host.active = false; host.online = true; expect(grantItem("potion", 1).granted).toBe(false);
    host.online = false; host.capacity = false; expect(grantItem("potion", 1).granted).toBe(false);
    host.capacity = true; expect(grantItem("potion", 10).granted).toBe(false);
    expect(host.writes).toBe(0);
  });
  it("marks unreadable results uncertain so callers cannot refund and retry blindly", () => {
    host.throwAfter = true;
    expect(grantItem("potion", 1)).toMatchObject({ granted: false, uncertain: true, before: 2 });
    expect(host.writes).toBe(1);
  });
});

it("permits the owned solo arena between waves and rejects live actors or stale quest contexts", () => {
  host.active = true;
  const context = { questId: 900102, questUnique: 42 };
  expect(grantItem("potion", 1, context).granted).toBe(true);
  host.live = true; expect(grantItem("potion", 1, context).granted).toBe(false);
  host.live = false; host.unique = 43; expect(grantItem("potion", 1, context).granted).toBe(false);
  host.unique = 42; host.online = true; expect(grantItem("potion", 1, context).granted).toBe(false);
  expect(host.writes).toBe(1);
});
