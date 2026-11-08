import { beforeEach, describe, expect, it, vi } from "vitest";

const ARMOR_SPELL = "tryAddGameItem(snow.data.DataDef.PlArmorId, snow.data.EquipmentInventoryData)";
const WEAPON_SPELL = "tryAddGameItem(snow.data.ContentsIdSystem.WeaponId, snow.data.EquipmentInventoryData, System.Boolean)";

interface FakeEntry { _IdType: number; _IdVal: number; _Name?: string }

function entryFacade(e: FakeEntry) {
  return {
    get_field: (n: string): unknown => (n === "_IdType" ? e._IdType : n === "_IdVal" ? e._IdVal : undefined),
    set_field: (n: string, v: unknown): void => {
      if (n === "_IdType") e._IdType = v as number;
      if (n === "_IdVal") e._IdVal = v as number;
    },
    call: (n: string): unknown => (n === "getName" ? (e._Name ?? null) : null),
  };
}

const host = vi.hoisted(() => ({
  persistFails: false,
  entries: [] as FakeEntry[],
  boxFacade: null as Record<string, unknown> | null,
  persisted: null as unknown,
}));

vi.mock("./sdk", () => ({
  getSingleton: () => ({
    get_field: () => null,
    call: (m: string) => (m === "getEquipBox" ? host.boxFacade : null),
  }),
  relog: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
  rejson: {
    dump_file: (_p: string, data: unknown) => { if(host.persistFails) return false; host.persisted = data; return true; },
    load_file: () => host.persisted,
  },
}));

import { appendGrantedEntry, loadStartupState, restoreStartup } from "./equip_wear";
import { GachaService } from "./gacha";

let boxFacade: {
  get_field(n: string): unknown;
  call(name: string, ...args: unknown[]): unknown;
  get_type_definition(): { get_method(name: string): unknown };
};

function buildWorld(): void {
  host.entries = [];
  for (let i = 0; i < 4; i++) host.entries.push({ _IdType: 0, _IdVal: 0 });
  const listFacade = {
    call: (n: string, i?: number): unknown =>
      n === "get_Count" ? host.entries.length : n === "get_Item" ? entryFacade(host.entries[i as number]!) : null,
  };
  boxFacade = {
    get_field: (n: string) => (n === "_WeaponArmorInventoryList" ? listFacade : null),
    get_type_definition: () => ({ get_method: (n: string) => (n === ARMOR_SPELL || n === WEAPON_SPELL ? {} : null) }),
    call(name: string, ...args: unknown[]): unknown {
      if (name === "getEmptyWeaponArmorInventoryFirst") {
        const slot = host.entries.find((e) => e._IdType === 0);
        return slot ? entryFacade(slot) : null;
      }
      if (name === "countWeaponArmorEmptyNum") return host.entries.filter((e) => e._IdType === 0).length;
      if (name === ARMOR_SPELL || name === WEAPON_SPELL) {
        const slot = args[1] as { set_field(n: string, v: unknown): void };
        slot.set_field("_IdVal", args[0]);
        slot.set_field("_IdType", name === ARMOR_SPELL ? 2 : 1);
        return null;
      }
      if (name === "subEquipment") {
        const obj = args[0] as { get_field(n: string): unknown };
        const found = host.entries.find((e) => e._IdVal === obj.get_field("_IdVal") && e._IdType === obj.get_field("_IdType"));
        if (found) { found._IdType = 0; found._IdVal = 0; }
        return null;
      }
      return null;
    },
  };
  host.boxFacade = boxFacade;
}

const POOLS = {
  gacha_1: { entries: [
    { kind: "armor" as const, id: 0x0c100009, w: 1 },
    { kind: "armor" as const, id: 0x0c500092, w: 3 },
  ] },
  empty: { entries: [] },
};

beforeEach(() => { buildWorld(); host.persistFails=false; host.persisted = null; host.rollQueue = []; });

describe("gacha", () => {
  it("按权重抽中并发放，读回名字", () => {
    const svc = new GachaService(POOLS, { rollIndex: () => 1 });
    const r = svc.roll("gacha_1");
    expect(r.ok).toBe(true);
    expect(r.id).toBe(0x0c500092);
    expect(r.boxIndex).toBe(0);
    expect(r.reused).toBe(false);
  });

  it("rollIndex 决定选中项", () => {
    const svc = new GachaService(POOLS, { rollIndex: () => 0 });
    expect(svc.roll("gacha_1").id).toBe(0x0c100009);
  });

  it("同款抽取仍发独立临时装备，玩家原有条目不进回收清单", () => {
    host.entries[0] = { _IdType: 2, _IdVal: 0x0c100009, _Name: "合金头盔" };
    const svc = new GachaService(POOLS, { rollIndex: () => 0 });
    const r = svc.roll("gacha_1");
    expect(r.ok).toBe(true);
    expect(r.reused).toBe(false);
    expect(r.boxIndex).toBe(1);
    expect(host.entries[0]!._Name).toBe("合金头盔");
  });

  it("空池/未配置 → 拒绝", () => {
    const svc = new GachaService(POOLS, { rollIndex: () => 0 });
    expect(svc.roll("empty").ok).toBe(false);
    expect(svc.roll("missing").ok).toBe(false);
    expect(svc.hasPool("gacha_1")).toBe(true);
    expect(svc.hasPool("empty")).toBe(false);
  });

  it("EquipBox 不可用 → 拒绝", () => {
    vi.mocked;
    const svc = new GachaService(POOLS, { rollIndex: () => 0 });
    // 模拟单例失效：直接把 entries 清空拿不到槽
    host.entries.length = 0;
    expect(svc.roll("gacha_1").ok).toBe(false);
  });

  it("appendGrantedEntry 并入局末清理；空 prevPack 不触发 pack 写回", () => {
    host.entries[0] = { _IdType: 2, _IdVal: 0x0c100009 }; // 假箱内确有该发件
    expect(appendGrantedEntry({ boxIndex: 0, idVal: 0x0c100009, idType: 2 })).toBe(true);
    expect(loadStartupState()?.granted).toHaveLength(1);
    const report = restoreStartup({ beginPouchIsolation: () => ({ ok: true }), endPouchIsolation: () => ({ ok: true }) });
    expect(report.ok).toBe(true);
    expect(report.restoredPack).toBe(false);
    expect(report.removedEntries).toBe(1);
    expect(host.entries[0]!._IdType).toBe(0);
    expect(loadStartupState()).toBeNull();
  });

  it("开局状态存在时 gacha 发件追加到同一清单", () => {
    host.persisted = { active: true, armor: "铁套", prevPack: [1, 2, 3, 4, 5, 6, 7, 8], granted: [], pouchIsolated: false };
    appendGrantedEntry({ boxIndex: 2, idVal: 0x0c100009, idType: 2 });
    expect(loadStartupState()?.granted).toHaveLength(1);
    expect(loadStartupState()?.prevPack).toHaveLength(8);
  });
});

it("refuses delivery when the cleanup journal cannot be saved",()=>{
  host.persistFails=true;
  const svc=new GachaService(POOLS,{rollIndex:()=>0});
  expect(svc.roll("gacha_1").ok).toBe(false);
  expect(host.entries.every(e=>e._IdType===0)).toBe(true);
});


it("does not refund a verified equipment grant just because its display-name lookup failed",()=>{
 const original=boxFacade.get_field;let reads=0;
 boxFacade.get_field=(n:string)=>{reads++;if(reads>3 && host.entries.some(e=>e._IdType!==0))throw Error("name list unavailable");return original(n);};
 const r=new GachaService(POOLS,{rollIndex:()=>0}).roll("gacha_1");
 expect(r.ok).toBe(true);expect(host.entries.filter(e=>e._IdType!==0)).toHaveLength(1);
});
