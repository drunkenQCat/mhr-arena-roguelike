import { beforeEach, describe, expect, it, vi } from "vitest";
const host = vi.hoisted(() => ({ count: 2, add: true, active: false, online: false, throwAfter: false,
  readBroken: false, capacity: true, writes: 0 }));
vi.mock("./sdk", () => ({
  getSingleton: (name: string) => {
    if (name === "snow.QuestManager") return { call: () => host.active };
    if (name === "snow.stage.StageManager") return { call: () => host.online };
    if (name === "snow.gui.GuiManager") return { call: (m: string) => m === "IsCanInvokeQuestBoard" };
    if (name === "snow.data.DataManager") return { get_field: () => ({ call: (m: string) => {
      if (m === "canAddItem") return host.capacity;
      if (m === "findInventoryData") {
        if (host.readBroken) throw new Error("count unavailable");
        return { call: () => host.count };
      }
      if (m === "tryAddGameItem") {
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
  throwAfter: false, readBroken: false, capacity: true, writes: 0 }));
describe("native delivery confirmation", () => {
  it("does not mistake a void no-op for successful delivery", () => {
    host.add = false;
    expect(grantItem("potion", 1)).toMatchObject({ granted: false, before: 2, after: 2, uncertain: false });
  });
  it("requires exactly one item to be observed in the pouch", () => {
    expect(grantItem("potion", 1)).toMatchObject({ granted: true, before: 2, after: 3 });
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
