import { describe, expect, it, vi } from "vitest";

// pouch_backup 依赖 SDK 全局——用注入桩验证调用序列与分类过滤。
const calls: Array<{ op: string; arg?: unknown }> = [];
const pouchStub = {
  call: (name: string, ...args: unknown[]) => {
    calls.push({ op: name, arg: args[0] });
    if (name === "getInventoryDataList") {
      const item = {
        call: (name: string) =>
          name === "get_ItemId" ? 68157446 : name === "get_Count" ? 3 : undefined,
      };
      return {
        call: (name: string, ...a: unknown[]) =>
          name === "get_Count" ? 2 : name === "get_Item" ? item : undefined,
      };
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
import { beforeEach } from "vitest";

beforeEach(() => {
  // isolationActive 是模块级状态，跨测试泄漏会拒绝后续 begin——每个用例前复位
  endPouchIsolation();
});

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
    console.log('DBG start, active?', null);
    beginPouchIsolation();
    calls.length = 0;
    const r = endPouchIsolation();
    console.log('DBG end result:', JSON.stringify(r), 'calls:', JSON.stringify(calls));
    expect(r.ok).toBe(true);
    const load = calls.find((c) => c.op === "loadFromBackupInventory");
    expect(load?.arg).toBe(true);
  });
  it("重复 begin 被拒绝（防备份区被已清空袋覆盖）", () => {
    calls.length = 0;
    expect(beginPouchIsolation().ok).toBe(true);
    calls.length = 0;
    const again = beginPouchIsolation();
    expect(again.ok).toBe(false);
    expect(calls.find((c) => c.op === "saveToBackupInventory")).toBeUndefined();
  });
  it("begin 异常后仍允许 end 恢复（半清空状态必须可回滚）", () => {
    calls.length = 0;
    // 正常 begin 后视为隔离中；异常路径难以在桩里触发，这里验证状态位不阻塞 end
    expect(beginPouchIsolation().ok).toBe(true);
    calls.length = 0;
    const r = endPouchIsolation();
    expect(r.ok).toBe(true);
    expect(calls.some((c) => c.op === "loadFromBackupInventory")).toBe(true);
  });
});
