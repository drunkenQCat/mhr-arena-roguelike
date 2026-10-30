/**
 * 开局装备与恢复 —— V1.3 §1.2 初始二选一（骨套/铁套）。
 * 全部基于 2026-10-29 实测结论（docs/research-shop-unavailable-and-equipment-wiring.md §3/§4）：
 *  - 权威穿装状态 = EquipDataManager.get_PlEquipPack()._InventoryIndexList（System.Int32[]，8 槽：
 *    [武器, 头, 身, 腕, 腰, 脚, 虫笼, 护石]，-1=空）。sol 下标写安全生效，读回用 get_Item。
 *  - changeEquip/changeEquipment 在村庄是无效摆设；equipPlDefaultData 先抛后写，禁用。
 *  - 装备箱发放必须用显式重载名（防具两参；带空格拼写命中，无空格兜底）。
 *  - 读回验证只用 pack 数组本身。
 * 本模块不抛异常：所有失败都进 Report；中途失败会尝试回滚原装并撤销本局新发条目。
 */

import { getSingleton, rejson, relog, type REManagedObject, type RETypeDefinition } from "./sdk";
import type { StartupRules } from "../core/config";

/** pack 槽位（0 基）。 */
export const PACK_WEAPON = 0;
export const PACK_HEAD = 1;
export const PACK_CHEST = 2;
export const PACK_ARM = 3;
export const PACK_WAIST = 4;
export const PACK_LEG = 5;
export const PACK_INSECT = 6;
export const PACK_TALISMAN = 7;
export const PACK_LEN = 8;

/** PlArmorId 编码：0x0C<部位 1..5><系列>（部位 1=头 2=身 3=腕 4=腰 5=脚，已实测）。 */
export function armorId(series: number, part: 1 | 2 | 3 | 4 | 5): number {
  return 0x0c000000 + part * 0x100000 + series;
}

function dataManager(): REManagedObject | null {
  return getSingleton("snow.data.DataManager");
}

function equipDataManager(): REManagedObject | null {
  return getSingleton("snow.data.EquipDataManager");
}

function equipmentBox(dm: REManagedObject | null): REManagedObject | null {
  if (!dm) return null;
  try {
    return (dm.get_field("_PlEquipBox") as REManagedObject | null) ??
      (dm.call("getEquipBox") as REManagedObject | null);
  } catch {
    return null;
  }
}

function weaponArmorList(box: REManagedObject | null): REManagedObject | null {
  if (!box) return null;
  return box.get_field("_WeaponArmorInventoryList") as REManagedObject | null;
}

const ADD_ARMOR_SPELLS = [
  "tryAddGameItem(snow.data.DataDef.PlArmorId, snow.data.EquipmentInventoryData)",
  "tryAddGameItem(snow.data.DataDef.PlArmorId,snow.data.EquipmentInventoryData)",
];
const ADD_WEAPON_SPELL = "tryAddGameItem(snow.data.ContentsIdSystem.WeaponId, snow.data.EquipmentInventoryData, System.Boolean)";

/** 命中第一个可用的显式重载名；全 miss 返回 null。 */
function findOverload(td: RETypeDefinition, spells: string[]): string | null {
  for (const spell of spells) {
    try {
      if (td.get_method(spell)) return spell;
    } catch { /* 命名不合法就换下一个拼写 */ }
  }
  return null;
}

/** 读权威 pack。失败返回 null（调用方不得假装成功）。 */
export function readPack(edm: REManagedObject | null): number[] | null {
  if (!edm) return null;
  try {
    const pack = edm.call("get_PlEquipPack") as REManagedObject | null;
    const arr = pack ? (pack.get_field("_InventoryIndexList") as REManagedObject | null) : null;
    if (!arr) return null;
    const count = arr.call("get_Count") as number;
    if (!Number.isInteger(count) || count < PACK_LEN) return null;
    const out: number[] = [];
    for (let i = 0; i < PACK_LEN; i++) {
      const v = arr.call("get_Item", i) as number;
      if (typeof v !== "number") return null;
      out.push(v);
    }
    return out;
  } catch {
    return null;
  }
}

/** 下标写一格（sol __newindex），写完读回核验。 */
export function writePackSlot(edm: REManagedObject | null, pos: number, boxIndex: number): boolean {
  if (!edm || pos < 0 || pos >= PACK_LEN) return false;
  try {
    const pack = edm.call("get_PlEquipPack") as REManagedObject | null;
    const arr = pack ? (pack.get_field("_InventoryIndexList") as REManagedObject | null) : null;
    if (!arr) return false;
    (arr as unknown as Record<number, number>)[pos] = boxIndex;
  } catch {
    return false;
  }
  const verify = readPack(edm);
  return verify !== null && verify[pos] === boxIndex;
}

/** 扫装备箱找 idVal 对应条目的箱内索引；找不到返回 null。 */
export function findEquipEntry(box: REManagedObject | null, idVal: number, idType: number): number | null {
  const list = weaponArmorList(box);
  if (!list) return null;
  try {
    const count = list.call("get_Count") as number;
    if (!Number.isInteger(count) || count < 0 || count > 100000) return null;
    for (let i = 0; i < count; i++) {
      const entry = list.call("get_Item", i) as REManagedObject | null;
      if (!entry) continue;
      if ((entry.get_field("_IdVal") as number) === idVal &&
        (entry.get_field("_IdType") as number) === idType) return i;
    }
  } catch { /* 箱不可读视同没找到 */ }
  return null;
}

function boxEntry(box: REManagedObject | null, index: number): REManagedObject | null {
  const list = weaponArmorList(box);
  if (!list) return null;
  try {
    return list.call("get_Item", index) as REManagedObject | null;
  } catch {
    return null;
  }
}

export interface GrantReport {
  ok: boolean;
  uncertain?: boolean;
  boxIndex?: number;
  reused?: boolean;
  reason?: string;
}

/**
 * 往装备箱发放一件装备（武器/防具）。读回 _IdType/_IdVal + 空槽数减一才算交付；
 * 部分写入标 uncertain，绝不自动重试。
 */
export function grantEquip(box: REManagedObject | null, idVal: number, kind: "armor" | "weapon",
  beforeGrant?: (entry: GrantedEntry) => boolean): GrantReport {
  if (!box) return { ok: false, reason: "EquipBox unavailable" };
  const expectType = kind === "armor" ? 2 : 1;
  const existing = findEquipEntry(box, idVal, expectType);
  if (existing !== null) return { ok: true, reused: true, boxIndex: existing };
  let slot: REManagedObject | null = null;
  try {
    const candidate = box.call("getEmptyWeaponArmorInventoryFirst") as REManagedObject | null;
    slot = candidate && (candidate.get_field("_IdType") as number) === 0 ? candidate : null;
  } catch { /* 槽接口失败按无空槽 */ }
  if (!slot) return { ok: false, reason: "装备箱无空槽" };
  let before = -1;
  try {
    before = box.call("countWeaponArmorEmptyNum") as number;
  } catch { /* 只影响辅助核验 */ }
  let spell: string | null = null;
  try {
    spell = findOverload(box.get_type_definition(),
      kind === "armor" ? ADD_ARMOR_SPELLS : [ADD_WEAPON_SPELL]);
  } catch {
    return { ok: false, reason: "EquipBox 类型不可读" };
  }
  if (!spell) return { ok: false, reason: `tryAddGameItem ${kind} 显式重载不存在` };
  const list = weaponArmorList(box);
  let reservedIndex = -1;
  if (list) for (let i = 0; i < (list.call("get_Count") as number); i++) {
    const candidate = boxEntry(box, i);
    if (candidate && (candidate === slot || (identity(candidate) !== undefined && identity(candidate) === identity(slot)))) {
      reservedIndex = i; break;
    }
    // Test facades lack addresses; production objects always expose get_address.
    if (identity(slot) === undefined && candidate?.get_field("_IdType") === 0) { reservedIndex = i; break; }
  }
  if (reservedIndex < 0) return { ok: false, reason: "Cannot identify empty equipment slot" };
  if (beforeGrant && !beforeGrant({ boxIndex: reservedIndex, idVal, idType: expectType, identity: identity(slot) })) {
    return { ok: false, reason: "Equipment recovery journal could not be saved" };
  }
  try {
    if (kind === "armor") box.call(spell, idVal, slot);
    else box.call(spell, idVal, slot, false);
  } catch (error) {
    relog.error(`[MhwRogue] grantEquip 原生调用抛出（写入仍可能发生）: ${String(error)}`);
  }
  // 抛错≠未写入：读回裁决
  const idType = slot.get_field("_IdType") as number;
  const gotId = slot.get_field("_IdVal") as number;
  let after = -1;
  try {
    after = box.call("countWeaponArmorEmptyNum") as number;
  } catch { /* 同上 */ }
  const boxIndex = findEquipEntry(box, idVal, expectType);
  if (idType === expectType && gotId === idVal) {
    const slotCountOk = before < 0 || after === before - 1;
    return {
      ok: true, uncertain: false, boxIndex: boxIndex ?? undefined,
      ...(slotCountOk ? {} : { reason: "空槽数读回不一致（条目已写入）" }),
    };
  }
  if (gotId === idVal || idType !== 0 || boxIndex !== null) {
    return { ok: false, uncertain: true, reason: "写入状态不明：槽位已被触碰但未达期望类型，禁止自动重试" };
  }
  return { ok: false, reason: "写入未生效（槽位仍为空）" };
}

function identity(obj: REManagedObject): string | undefined {
  try { return String(obj.get_address()); } catch { return undefined; }
}
export interface GrantedEntry { boxIndex: number; idVal: number; idType: number; identity?: string; removed?: boolean }

function recordedEntry(box: REManagedObject, entry: GrantedEntry): REManagedObject | null {
  const obj = boxEntry(box, entry.boxIndex);
  if (!obj) throw new Error("Equipment slot unavailable");
  if (obj.get_field("_IdType") === 0) return null;
  if (obj.get_field("_IdType") !== entry.idType || obj.get_field("_IdVal") !== entry.idVal ||
      (entry.identity !== undefined && identity(obj) !== entry.identity)) {
    throw new Error("Equipment instance changed; recovery retained for manual inspection");
  }
  return obj;
}

export interface StartupWearReport {
  ok: boolean;
  armor: string;
  /** 原装 pack（恢复真值）。读到 pack 后的失败路径也会返回。 */
  prevPack: number[] | null;
  wornPack: number[] | null;
  /** 本局新发放（非复用）的条目，局末清理用。 */
  granted: GrantedEntry[];
  pouchIsolated: boolean;
  pouchReason?: string;
  /** 失败路径是否已尝试回滚（原装 pack + 撤销新发条目）。 */
  rollbackAttempted?: boolean;
  reason?: string;
}

export interface EquipWearPort {
  /** 供 NativeRuntime 注入的袋隔离动作（pouch_backup）。 */
  beginPouchIsolation(): { ok: boolean; reason?: string; recoveryRequired?: boolean };
  endPouchIsolation(): { ok: boolean; reason?: string };
}

const STATE_FILE = "mhw_rogue_startup_state.json";

interface PersistedState {
  active: boolean;
  armor: string | null;
  prevPack: number[];
  granted: GrantedEntry[];
  pouchIsolated: boolean;
}

export function persistStartupState(state: PersistedState | null): boolean {
  try {
    return rejson.dump_file(STATE_FILE, state ?? { active: false, armor: null, prevPack: [],
      granted: [], pouchIsolated: false }, 2) === true;
  } catch (error) {
    relog.error(`[MhwRogue] startup journal failed: ${String(error)}`);
    return false;
  }
}

export function loadStartupState(): PersistedState | null {
  try {
    const raw = rejson.load_file(STATE_FILE) as PersistedState | null;
    if (!raw || raw.active !== true) return null;
    // REFramework serializes an empty Lua array as JSON null.
    raw.prevPack = raw.prevPack ?? [];
    raw.granted = raw.granted ?? [];
    if (!Array.isArray(raw.prevPack) || !Array.isArray(raw.granted)) throw new Error("Invalid startup journal");
    return raw;
  } catch {
    return null;
  }
}

/**
 * 开局穿戴：保存原装 → 按规则卸护石/虫笼 → 发放并穿上五件 → 读回核验。
 * 任一步失败：尝试回滚原装 pack 并撤销本局新发条目，然后报告失败（不抛异常）。
 * 袋隔离只在装备全部成功后执行；隔离失败不阻断开局（零物资是规则不是安全前提）。
 */
export function equipStartupSet(armor: string, series: number, rules: StartupRules,
  pouch: EquipWearPort | null): StartupWearReport {
  const report: StartupWearReport = { ok: false, armor, prevPack: null, wornPack: null, granted: [], pouchIsolated: false };
  const edm = equipDataManager();
  const box = equipmentBox(dataManager());
  if (!edm || !box) {
    report.reason = "EquipDataManager/EquipBox unavailable";
    return report;
  }
  if (loadStartupState()) {
    report.reason = "Previous startup recovery must finish before starting another run";
    return report;
  }
  const prev = readPack(edm);
  if (!prev) {
    report.reason = "PlEquipPack 不可读";
    return report;
  }
  report.prevPack = prev.slice();

  const granted: GrantedEntry[] = [];
  const journal: PersistedState = { active: true, armor, prevPack: prev, granted, pouchIsolated: false };
  if (!persistStartupState(journal)) { report.reason = "Cannot save original equipment"; return report; }
  const reserve = (entry: GrantedEntry): boolean => {
    granted.push(entry);
    return persistStartupState(journal);
  };
  const fail = (reason: string): StartupWearReport => {
    const rollback = restoreStartup(pouch);
    return { ...report, granted, rollbackAttempted: true,
      reason: `${reason}; recovery ${rollback.ok ? "completed" : "pending: " + rollback.reason}` };
  };

  for (const [pos, strip] of [[PACK_TALISMAN, rules.stripTalismans], [PACK_INSECT, rules.stripInsect]] as const) {
    if (strip && !writePackSlot(edm, pos, -1)) {
      return fail(`卸装失败：pack[${pos}] 写入后读回不一致`);
    }
  }

  for (let part = 1 as 1 | 2 | 3 | 4 | 5; part <= 5; part++) {
    const id = armorId(series, part);
    const grant = grantEquip(box, id, "armor", reserve);
    if (!grant.ok || grant.boxIndex === undefined) {
      return fail(`防具发放失败（部位 ${part}）: ${grant.reason ?? "未知"}${grant.uncertain ? "［结果不明，禁止自动重试］" : ""}`);
    }

    if (!writePackSlot(edm, part, grant.boxIndex)) {
      return fail(`穿装失败：pack[${part}] 写入后读回不一致`);
    }
  }

  // D1 武器口子：keepPlayerWeapon=false 时按 weaponId 发放并穿上（配置校验保证非空）
  if (!rules.keepPlayerWeapon && rules.weaponId !== null) {
    const grant = grantEquip(box, rules.weaponId, "weapon", reserve);
    if (!grant.ok || grant.boxIndex === undefined) {
      return fail(`武器发放失败: ${grant.reason ?? "未知"}`);
    }

    if (!writePackSlot(edm, PACK_WEAPON, grant.boxIndex)) {
      return fail("武器穿装失败：pack[0] 读回不一致");
    }
  }

  const finalPack = readPack(edm);
  if (!finalPack) {
    return fail("终态 pack 不可读");
  }
  for (let part = 1; part <= 5; part++) {
    const expected = findEquipEntry(box, armorId(series, part as 1 | 2 | 3 | 4 | 5), 2);
    if (expected === null || finalPack[part] !== expected) {
      return fail(`穿装读回不一致：pack[${part}]=${finalPack[part]} 期望 ${expected}`);
    }
  }
  if (rules.stripTalismans && finalPack[PACK_TALISMAN] !== -1) {
    return fail("护石未卸下（pack[7] 读回非 -1）");
  }

  report.ok = true;
  report.wornPack = finalPack;
  report.granted = granted;
  if (pouch) {
    // Arm recovery BEFORE any pouch mutation, including partially failed clears.
    journal.pouchIsolated = true;
    if (!persistStartupState(journal)) return fail("Cannot journal pouch recovery");
    const pouchReport = pouch.beginPouchIsolation();
    journal.pouchIsolated = pouchReport.recoveryRequired !== false;
    report.pouchIsolated = journal.pouchIsolated;
    report.pouchReason = pouchReport.ok ? undefined : pouchReport.reason;
  }
  if (!persistStartupState(journal)) return fail("Cannot save startup completion");
  return report;
}

/**
 * 把非开局发放的装备（抽取/掉落）并入局末清理清单。
 * 无活动状态时构造只含发件的记录（prevPack 置空标记"恢复期跳过 pack 写回"）。
 */
export function appendGrantedEntry(entry: GrantedEntry): boolean {
  const state = loadStartupState();
  const merged: PersistedState = state ?? {
    active: true, armor: null, prevPack: [], granted: [], pouchIsolated: false,
  };
  merged.active = true;
  merged.granted = merged.granted.concat([entry]);
  try {
    return persistStartupState(merged);
  } catch {
    return false;
  }
}

export interface RestoreReport {
  ok: boolean;
  restoredPack?: boolean;
  removedEntries?: number;
  skippedEntries?: number;
  pouchRestored?: boolean;
  reason?: string;
}

/**
 * 回村恢复（幂等）：恢复 pack → 清理本局发件 → 袋备份还原 → 清持久化。
 * 无待恢复状态时返回 ok=true 的 no-op；失败保持待办（调用方稍后重试）。
 */
export function restoreStartup(pouch: EquipWearPort | null): RestoreReport {
  const state = loadStartupState();
  if (!state) {
    return { ok: true, restoredPack: false, removedEntries: 0, skippedEntries: 0, pouchRestored: false };
  }
  const edm = equipDataManager();
  const box = equipmentBox(dataManager());
  if (!edm) {
    return { ok: false, reason: "EquipDataManager unavailable；恢复保持待办" };
  }
  const result: RestoreReport = { ok: true, restoredPack: false, removedEntries: 0, skippedEntries: 0, pouchRestored: false };
  const removed = (): number => (result.removedEntries ?? 0);
  const skipped = (): number => (result.skippedEntries ?? 0);
  // prevPack 为空 = 该记录只含发件清理（抽取/掉落），没有 pack 恢复语义
  if (state.prevPack.length === PACK_LEN) {
    let packOk = true;
    for (let i = 0; i < PACK_LEN; i++) {
      if (!writePackSlot(edm, i, state.prevPack[i] ?? -1)) {
        packOk = false;
        break;
      }
    }
    result.restoredPack = packOk;
    if (!packOk) {
      return { ...result, ok: false, reason: "pack 恢复读回不一致；恢复保持待办" };
    }
  }
  for (const entry of state.granted) {
    if (entry.removed) continue;
    if (!box) return { ...result, ok: false, reason: "Equipment box unavailable" };
    try {
      const obj = recordedEntry(box, entry);
      if (obj) {
        box.call("subEquipment", obj);
        if (recordedEntry(box, entry) !== null) throw new Error("Equipment removal readback failed");
        result.removedEntries = removed() + 1;
      } else result.skippedEntries = skipped() + 1;
      entry.removed = true;
      if (!persistStartupState(state)) throw new Error("Cannot save cleanup progress");
    } catch (error) {
      return { ...result, ok: false, reason: String(error) };
    }
  }
  if (state.pouchIsolated && pouch) {
    const pouchReport = pouch.endPouchIsolation();
    result.pouchRestored = pouchReport.ok;
    if (!pouchReport.ok) {
      return { ...result, ok: false, reason: `道具袋恢复失败: ${pouchReport.reason ?? "未知"}；装备已恢复` };
    }
  }
  if (!persistStartupState(null)) return { ...result, ok: false, reason: "Cannot retire recovery journal" };
  relog.info(`[MhwRogue] 开局装备已恢复（发件清理 ${result.removedEntries}/${state.granted.length}）`);
  return result;
}
