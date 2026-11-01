import { beforeEach, describe, expect, it, vi } from "vitest";

const ARMOR_SPELL = "tryAddGameItem(snow.data.DataDef.PlArmorId, snow.data.EquipmentInventoryData)";
const WEAPON_SPELL = "tryAddGameItem(snow.data.ContentsIdSystem.WeaponId, snow.data.EquipmentInventoryData, System.Boolean)";

interface FakeEntry { _IdType: number; _IdVal: number }

function entryFacade(e: FakeEntry) {
  return {
    ref: e,
    get_field: (n: string): unknown => (n === "_IdType" ? e._IdType : n === "_IdVal" ? e._IdVal : undefined),
    set_field: (n: string, v: unknown): void => {
      if (n === "_IdType") e._IdType = v as number;
      if (n === "_IdVal") e._IdVal = v as number;
    },
  };
}

class FakePackArray extends Array<number> {
  call(name: string, index?: number): unknown {
    if (name === "get_Count") return this.length;
    if (name === "get_Item") return this[index as number];
    return undefined;
  }
}

const host = vi.hoisted(() => ({
  packArr: null as FakePackArray | null,
  packFacade: null as { get_field(n: string): unknown } | null,
  boxFacade: null as Record<string, unknown> | null,
  entries: [] as FakeEntry[],
  persistFails: false,
  grantWorks: true,
  grantThrows: false,
  persisted: null as unknown,
  removedIds: [] as number[],
}));

vi.mock("./sdk", () => ({
  getSingleton: (name: string) => {
    if (name === "snow.data.EquipDataManager") {
      return { call: (m: string) => (m === "get_PlEquipPack" ? host.packFacade : null) };
    }
    if (name === "snow.data.DataManager") {
      return {
        get_field: () => null,
        call: (m: string) => (m === "getEquipBox" ? host.boxFacade : null),
      };
    }
    return null;
  },
  relog: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
  rejson: {
    dump_file: (_p: string, data: unknown) => { if (host.persistFails) return false; host.persisted = JSON.parse(JSON.stringify(data)); return true; },
    load_file: () => host.persisted,
  },
}));

import { armorId, equipStartupSet, grantEquip, loadStartupState, readPack,
  restoreStartup, reapplyStartup, writePackSlot, appendGrantedEntry, type EquipWearPort } from "./equip_wear";

let packFacade: { get_field(n: string): unknown };
let boxFacade: {
  get_field(n: string): unknown;
  call(name: string, ...args: unknown[]): unknown;
  get_type_definition(): { get_method(name: string): unknown };
};

function buildWorld(initialPack: number[], preOwnedParts: number[], grantWorks = true): void {
  host.persistFails = false;
  host.grantWorks = grantWorks;
  host.grantThrows = false;
  host.removedIds = [];
  host.persisted = null;
  const pack = new FakePackArray(...initialPack);
  host.packArr = pack;
  packFacade = { get_field: (n: string) => (n === "_InventoryIndexList" ? pack : null) };
  host.packFacade = packFacade;

  host.entries = [];
  for (let part = 1; part <= 5; part++) {
    const id = armorId(9, part as 1 | 2 | 3 | 4 | 5);
    host.entries.push(preOwnedParts.includes(part) ? { _IdType: 2, _IdVal: id } : { _IdType: 0, _IdVal: 0 });
  }
  host.entries.push({ _IdType: 0, _IdVal: 0 }, { _IdType: 0, _IdVal: 0 });
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
        if (!host.grantWorks) {
          // 模拟错误重载派发：写入了 _IdVal 但类型未落（槽位被触碰）
          slot.set_field("_IdVal", args[0]);
          return null;
        }
        slot.set_field("_IdVal", args[0]);
        slot.set_field("_IdType", name === ARMOR_SPELL ? 2 : 1);
        if (host.grantThrows) throw new Error("native threw");
        return null;
      }
      if (name === "subEquipment") {
        const obj = args[0] as { get_field(n: string): unknown };
        const found = (obj as unknown as {ref: FakeEntry}).ref;
        if (found && found._IdType !== 0) {
          host.removedIds.push(found._IdVal);
          found._IdType = 0;
          found._IdVal = 0;
        }
        return null;
      }
      return null;
    },
  };
  host.boxFacade = boxFacade;
}

const pouchPort: EquipWearPort = {
  beginPouchIsolation: () => ({ ok: true }),
  endPouchIsolation: () => ({ ok: true }),
};
const RULES = { stripTalismans: true, stripInsect: false, keepPlayerWeapon: true, weaponId: null } as const;

const INITIAL = [90, 11, 12, 13, 14, 15, 60, 70];

beforeEach(() => buildWorld(INITIAL, []));

describe("equip_wear", () => {
  it("armorId 编码 = 0x0C<部位><系列>", () => {
    expect(armorId(9, 1)).toBe(0x0c100009);
    expect(armorId(146, 5)).toBe(0x0c500092);
  });

  it("开局穿装：五件穿上、护石卸下、武器保留、袋隔离、持久化", () => {
    const report = equipStartupSet("铁套（攻高防低）", 9, RULES, pouchPort);
    expect(report.ok).toBe(true);
    expect(report.wornPack).toEqual([90, 0, 1, 2, 3, 4, 60, -1]);
    expect(report.granted).toHaveLength(5);
    expect(report.pouchIsolated).toBe(true);
    expect(loadStartupState()?.active).toBe(true);
    expect(loadStartupState()?.prevPack).toEqual(INITIAL);
  });

  it("已拥有的条目复用，不重复发放", () => {
    buildWorld(INITIAL, [1, 2]);
    const report = equipStartupSet("铁套（攻高防低）", 9, RULES, pouchPort);
    expect(report.ok).toBe(true);
    expect(report.granted).toHaveLength(3);
    expect(report.wornPack![1]).toBe(0);
  });

  it("回村恢复：pack 写回、新发条目清理、持久化清除、幂等", () => {
    equipStartupSet("铁套（攻高防低）", 9, RULES, pouchPort);
    const report = restoreStartup(pouchPort);
    expect(report.ok).toBe(true);
    expect(readPack({ call: (m: string) => (m === "get_PlEquipPack" ? packFacade : null) })).toEqual(INITIAL);
    expect(report.removedEntries).toBe(5);
    expect(host.removedIds).toHaveLength(5);
    expect(loadStartupState()).toBeNull();
    expect(restoreStartup(pouchPort).restoredPack).toBe(false);
  });

  it("发放失败（写入不生效）→ 回滚原装并撤销已发条目", () => {
    buildWorld(INITIAL, [], false);
    const report = equipStartupSet("铁套（攻高防低）", 9, RULES, pouchPort);
    expect(report.ok).toBe(false);
    expect(report.rollbackAttempted).toBe(true);
    expect(readPack({ call: (m: string) => (m === "get_PlEquipPack" ? packFacade : null) })).toEqual(INITIAL);
    expect(host.entries.every((e) => e._IdType === 0)).toBe(true);
    expect(loadStartupState()).toBeNull();
  });

  it("原生抛错仍以读回裁决交付（抛错≠未写入）", () => {
    buildWorld(INITIAL, []);
    host.grantThrows = true;
    const grant = grantEquip(boxFacade, armorId(9, 1), "armor");
    expect(grant.ok).toBe(true);
    expect(grant.boxIndex).toBe(0);
  });

  it("uncertain：槽位被触碰但类型不对 → 禁止自动重试", () => {
    buildWorld(INITIAL, []);
    host.grantWorks = false;
    const grant = grantEquip(boxFacade, armorId(9, 1), "armor");
    expect(grant.ok).toBe(false);
    expect(grant.uncertain).toBe(true);
  });

  it("D1 武器口子：keepPlayerWeapon=false + weaponId 收旧发新", () => {
    const report = equipStartupSet("铁套（攻高防低）", 9,
      { stripTalismans: true, stripInsect: false, keepPlayerWeapon: false, weaponId: 0x085001b8 }, pouchPort);
    expect(report.ok).toBe(true);
    expect(report.wornPack![0]).toBe(5);
    expect(report.granted.some((g) => g.idType === 1 && g.idVal === 0x085001b8)).toBe(true);
  });

  it("EquipDataManager 不可用时报失败而非假装成功", () => {
    host.packArr = null;
    host.packFacade = null;
    const report = equipStartupSet("铁套（攻高防低）", 9, RULES, pouchPort);
    expect(report.ok).toBe(false);
  });

  it("writePackSlot 读回不一致即失败", () => {
    host.packArr = null;
    expect(writePackSlot({ call: () => null }, 1, 3)).toBe(false);
  });
});

it("does not mutate equipment when the original journal cannot be saved", () => {
  host.persistFails=true;
  expect(equipStartupSet("test",9,RULES,pouchPort).ok).toBe(false);
  expect([...host.packArr!]).toEqual(INITIAL);
  expect(appendGrantedEntry({boxIndex:0,idVal:42,idType:2})).toBe(false);
});
it("deletes only the recorded copy rather than the first matching equipment ID", () => {
  const id=armorId(9,1); host.entries[0]={_IdType:2,_IdVal:id}; host.entries[1]={_IdType:2,_IdVal:id};
  host.persisted={active:true,prevPack:[],granted:[{boxIndex:1,idVal:id,idType:2}],pouchIsolated:false};
  expect(restoreStartup(null).ok).toBe(true);
  expect(host.entries[0]._IdType).toBe(2); expect(host.entries[1]._IdType).toBe(0);
});
it("partial pouch failure retains the recovery obligation", () => {
  const end=vi.fn(()=>({ok:true}));
  const port={beginPouchIsolation:()=>({ok:false,reason:"partial clear"}),endPouchIsolation:end};
  const r=equipStartupSet("test",9,RULES,port);
  expect(r.pouchIsolated).toBe(true); expect(loadStartupState()?.pouchIsolated).toBe(true);
  expect(restoreStartup(port).ok).toBe(true); expect(end).toHaveBeenCalledOnce();
});
it("a pouch retry never deletes equipment a second time", () => {
  equipStartupSet("test",9,RULES,pouchPort);
  expect(restoreStartup({beginPouchIsolation:()=>({ok:true}),endPouchIsolation:()=>({ok:false})}).ok).toBe(false);
  const removed=host.removedIds.length;
  expect(restoreStartup(pouchPort).ok).toBe(true); expect(host.removedIds.length).toBe(removed);
});

it("reapplies the chosen run pack after native reentry restored the old one, without granting twice",()=>{
 const r=equipStartupSet("test",9,RULES,pouchPort);expect(r.ok).toBe(true);
 for(let i=0;i<INITIAL.length;i++)host.packArr![i]=INITIAL[i]!;
 expect(reapplyStartup().ok).toBe(true);expect([...host.packArr!]).toEqual(r.wornPack);
 expect((host.persisted as any).granted).toHaveLength(5);
});
it("never searches for a user-owned same-ID replacement when the recorded slot changes",()=>{
 const id=armorId(9,1);host.entries[0]={_IdType:2,_IdVal:id};host.entries[1]={_IdType:2,_IdVal:123};
 host.persisted={active:true,prevPack:[],granted:[{boxIndex:1,idType:2,idVal:id}],pouchIsolated:false};
 expect(restoreStartup(null).ok).toBe(false);expect(host.entries[0]._IdType).toBe(2);
});
