import { describe, expect, it, vi } from "vitest";

// pouch_backup 依赖 SDK 全局——用注入桩验证调用序列与分类过滤。
const calls: Array<{ op: string; arg?: unknown }> = [];
const pouchStub = {
  call: (name: string, ...args: unknown[]) => {
    calls.push({ op: name, arg: args[0] });
    if (name === "getInventoryDataList") {
      return { get_Count: () => 2, get_Item: () => ({ get_ItemId: () => 68157446, get_Count: () => 3 }) };
    }
    return undefined;
  },
  saveToBackupInventory: () => calls.push({ op: "save" }),
  loadFromBackupInventory: (flag: boolean) => calls.push({ op: "load", arg: flag }),
  clear: (t: number) => calls.push({ op: "clear", arg: t }),
};

vi.mock("./sdk", () => {
  return {
    getSingleton: () => ({ get_field: () => pouchStub }),
    findTypeDefinition: () => ({
      get_fields: () => [
        { get_name: () => "NORMAL", is_static: () => true, get_data: () => 0 },
        { get_name: () => "AMMO", is_static: () => true, get_data: () => 1 },
        { get_name: () => "BOTTLE", is_static: () => true, get_data: () => 2 },
        { get_name: () => "WIRE", is_static: () => true, get_data: () => 3 },
      ],
    }),
    relog: { info: () => {}, warn: () => {}, error: () => {} },
  };
});

import { beginPouchIsolation, endPouchIsolation } from "./pouch_backup";

describe("pouch_backup（零物资隔离，原生备份机制）", () => {
  it("begin：先备份、再按白名单分类清空（WIRE 不碰）", () => {
    calls.length = 0;
    const r = beginPouchIsolation();
    expect(r.ok).toBe(true);
    const ops = calls.map((c) => c.op);
    expect(ops[0]).toBe("saveToBackupInventory");
    expect(ops.filter((o) => o === "clear").length).toBe(3);
  });

  it("end：loadFromBackupInventory(true)（排除翔虫钥语义）", () => {
    calls.length = 0;
    const r = endPouchIsolation();
    expect(r.ok).toBe(true);
    const load = calls.find((c) => c.op === "loadFromBackupInventory");
    expect(load?.arg).toBe(true);
  });
});
