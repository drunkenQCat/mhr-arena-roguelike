/**
 * 道具袋原生备份/恢复 —— 文档 §4.1（零物资开局、结束恢复）。
 * 用 ItemPouch 自己的备份机制，不自研字段复制：
 *   saveToBackupInventory()                       当前袋 → 引擎备份区
 *   loadFromBackupInventory(isExceptWireJumpInsectItem)
 *                                                 备份区 → 当前袋（可排除翔虫钥）
 *   getInventoryDataList(InventoryTypes)          按分类读（普通/临时/弹瓶/常驻/翔虫/狗袋…）
 *   clear(InventoryTypes)                         按分类清空（禁止一把清所有分类）
 *
 * InventoryTypes 枚举值以运行时 dump 的 snow.data.ItemPouch.InventoryTypes 为准；
 * 脚本加载时读取并缓存，读不到则本模块整体停用。
 * 2026-10-29 实机枚举：Normal=0, Temporary=1, BulletBottle=2, Regular=3,
 * WireJumpInsect=4, OtDogItemPouch=5。玩家物资袋只有 Normal + BulletBottle；
 * Temporary（任务补给临时袋）/Regular（常驻砥石等）/翔虫/狗袋不动。
 * （首版写的 "NORMAL/AMMO/BOTTLE" 是不存在的名字，clear 全部静默跳过——已修正。）
 *
 * 原生备份只是缓存，任务结算可能覆盖它。修改前另存带角色身份的持久记录，
 * 恢复时优先核验缓存，否则按记录重建并逐类读回。schema2 的分类总数处理
 * 空 Lua 表写成 JSON null 的绑定差异；缺失非空分类时不能当空背包恢复。
 */

import { findTypeDefinition, getSingleton, relog, rejson, type REManagedObject, type RETypeDefinition } from "./sdk";
import { readRecoveryRecord } from "./recovery_journal";
import { assertRecoveryOwner, readRecoveryOwner, type RecoveryOwner } from "./recovery_owner";

const POUCH = "snow.data.ItemPouch";

let inventoryTypes: Record<string, number> | null = null;
let typesLoaded = false;

interface StaticEnumField { get_name(): string; is_static(): boolean; get_data(o: unknown): unknown }
interface StaticEnumType { get_fields(): StaticEnumField[] }

/** 从运行时枚举读 InventoryTypes；失败则返回空表（各分类操作将安全失败）。 */
function inventoryTypesTable(): Record<string, number> {
  if (typesLoaded) return inventoryTypes ?? {};
  typesLoaded = true;
  try {
    const td = findTypeDefinition("snow.data.ItemPouch.InventoryTypes") as StaticEnumType | null;
    if (!td) return {};
    const out: Record<string, number> = {};
    for (const field of td.get_fields()) {
      if (!field.is_static()) continue;
      const data = field.get_data(null);
      if (typeof data === "number") out[field.get_name()] = data;
    }
    inventoryTypes = out;
    relog.info(`[MhwRogue] InventoryTypes: ${Object.keys(out).join(", ")}`);
  } catch (e) {
    relog.warn(`[MhwRogue] InventoryTypes 读取失败：${String(e)}`);
  }
  return inventoryTypes ?? {};
}

function itemPouch(): REManagedObject | null {
  const dm = getSingleton("snow.data.DataManager");
  if (!dm) return null;
  return (dm.get_field("_ItemPouch") as REManagedObject | null) ?? null;
}

export interface PouchSnapshot {
  ok: boolean;
  reason?: string;
  recoveryRequired?: boolean;
  /** 每分类的物品数（记录用；恢复走原生备份，不逐项重建）。 */
  counts?: Record<string, number>;
}

/** 读一个分类的物品数（id→数量），用于记录与对比。 */
function categoryCounts(pouch: REManagedObject, typeName: string): Record<string, number> | null {
  const table = inventoryTypesTable();
  const value = table[typeName];
  if (value === undefined) return null;
  try {
    const list = pouch.call("getInventoryDataList", value) as REManagedObject | null;
    if (!list) return null;
    const counts: Record<string, number> = {};
    const ok = list.call("get_Count") as number;
    for (let i = 0; i < ok; i++) {
      const item = list.call("get_Item", i) as REManagedObject | null;
      if (!item) continue;
      const itemId = item.call("get_ItemId");
      const num = item.call("get_Count");
      if (typeof num === "number" && num > 0) {
        counts[`${itemId}`] = (counts[`${itemId}`] ?? 0) + num;
      }
    }
    return counts;
  } catch { return null; }
}

/**
 * 开局快照：把当前道具袋存入引擎备份区，并清空玩家可见的分类。
 * 分类清单来自运行时 InventoryTypes 中可识别的玩家袋分类；
 * 保守策略：只清 Normal / BulletBottle（临时袋、常驻砥石、翔虫钥、狗袋不碰）。
 * 若 InventoryTypes 枚举读不到对应名，跳过该分类并记录。
 *
 * 隔离期保护（2026-10-28 审查补充）：
 * - 重复 begin 直接拒绝——第二次 saveToBackupInventory 会用"已清空的袋"
 *   覆盖备份区，造成原物资永久丢失；
 * - 隔离期间记录快照摘要，end 时读回比对，恢复异常必须上报而不是静默成功。
 */
let isolationActive = false;
const SNAPSHOT_FILE = "mhw_rogue_pouch_state.json";
/** Diagnostic boot tag only; verification is never relaxed after reload. */
const BOOT_ID = "boot:" + String(Math.random());
type InventorySnapshot = Record<string, Record<string, number>>;
const RESTORE_TYPES = [0, 1, 2, 3, 5]; // native load(true) excludes wirebugs (4)

function countList(list: REManagedObject | null): Record<string, number> {
  if (!list) throw new Error("Inventory list unavailable");
  const count = list.call("get_Count") as number;
  if (!Number.isInteger(count) || count < 0 || count > 10000) throw new Error("Invalid inventory length");
  const items: Record<string, number> = {};
  for (let i = 0; i < count; i++) {
    const slot = list.call("get_Item", i) as REManagedObject | null;
    if (!slot) throw new Error("Inventory slot unavailable");
    const id = slot.call("get_ItemId") as number;
    const n = slot.call("get_Count") as number;
    if (!Number.isInteger(n) || n < 0) throw new Error("Invalid inventory count");
    if (n > 0 && (!Number.isInteger(id) || id <= 0)) throw new Error("Invalid inventory item ID");
    if (n > 0) items[String(id)] = (items[String(id)] ?? 0) + n;
  }
  return items;
}
function inventorySnapshot(pouch: REManagedObject, backup: boolean): InventorySnapshot {
  const groups = backup ? pouch.call("get_BackupInventoryDataList") as REManagedObject | null : null;
  if (backup && !groups) throw new Error("Backup unavailable (not an empty backup)");
  const out: InventorySnapshot = {};
  for (const t of RESTORE_TYPES) out[String(t)] = countList(backup
    ? groups!.call("get_Item", t) as REManagedObject | null
    : pouch.call("getInventoryDataList", t) as REManagedObject | null);
  return out;
}
function sameSnapshot(a: InventorySnapshot, b: InventorySnapshot): boolean {
  for (const t of RESTORE_TYPES) {
    const x = a[String(t)] ?? {}, y = b[String(t)] ?? {};
    if (!x || !y || Object.keys(x).length !== Object.keys(y).length) return false;
    for (const id of Object.keys(x)) if (x[id] !== y[id]) return false;
  }
  return true;
}

function validateSnapshot(expected: InventorySnapshot, totals: number[]): void {
  if (!expected || typeof expected !== "object") throw new Error("Original pouch snapshot unavailable");
  if (!Array.isArray(totals) || totals.length !== RESTORE_TYPES.length || totals.some(n => !Number.isInteger(n) || n < 0))
    throw new Error("Original pouch category totals unavailable");
  for (let i = 0; i < RESTORE_TYPES.length; i++) {
    const t = RESTORE_TYPES[i]!;
    // The native JSON binding turns an empty Lua table into null, and loading
    // null removes that key. Explicit non-null totals distinguish empty from lost.
    if (expected[String(t)] == null && totals[i] === 0) expected[String(t)] = {};
    const group = expected[String(t)];
    if (!group || typeof group !== "object") throw new Error("Original pouch journal missing an inventory category");
    let sum = 0;
    for (const id of Object.keys(group)) {
      if (!Number.isInteger(Number(id)) || Number(id) <= 0 || !Number.isInteger(group[id]) || group[id]! <= 0)
        throw new Error("Original pouch journal has invalid item counts");
      sum += group[id]!;
    }
    if (sum !== totals[i]) throw new Error("Original pouch category total differs from saved items");
  }
}

export function beginPouchIsolation(): PouchSnapshot {
  let recoveryRequired = false;
  try {
    if (isolationActive || readRecoveryRecord<{ active:boolean }>(SNAPSHOT_FILE)?.active) return { ok: false, recoveryRequired: true, reason: "Pouch recovery already pending" };
    const owner = readRecoveryOwner();
    const pouch = itemPouch();
    if (!pouch) return { ok: false, recoveryRequired: false, reason: "Item pouch unavailable" };
    const table = inventoryTypesTable();
    if (table.Normal !== 0 || table.BulletBottle !== 2) return { ok: false, recoveryRequired: false, reason: "Inventory categories unavailable" };
    const original = inventorySnapshot(pouch, false);
    const stacks: Record<string, { id: number; n: number }[]> = {};
    for (const t of RESTORE_TYPES) {
      const list = pouch.call("getInventoryDataList", t) as REManagedObject;
      stacks[String(t)] = [];
      for (let i = 0; i < (list.call("get_Count") as number); i++) {
        const slot = list.call("get_Item", i) as REManagedObject;
        const n = slot.call("get_Count") as number;
        if (n > 0) stacks[String(t)]!.push({ id: slot.call("get_ItemId") as number, n });
      }
    }
    // A durable obligation exists before any native mutation.
    const categoryTotals = RESTORE_TYPES.map(t => Object.values(original[String(t)]!).reduce((sum, n) => sum + n, 0));
    if (rejson.dump_file(SNAPSHOT_FILE, { schema:2, active: true, owner, boot: BOOT_ID, items: original, stacks, categoryTotals }, 2) !== true) return { ok: false, recoveryRequired: false, reason: "Cannot journal original pouch" };
    isolationActive = true;
    recoveryRequired = true;
    pouch.call("saveToBackupInventory");
    if (!sameSnapshot(original, inventorySnapshot(pouch, true))) throw new Error("Native backup differs from original pouch");
    for (const t of [table.Normal, table.BulletBottle]) {
      pouch.call("clear", t);
      if (Object.keys(countList(pouch.call("getInventoryDataList", t) as REManagedObject)).length !== 0)
        throw new Error("Pouch clear readback failed");
    }
    return { ok: true, recoveryRequired };
  } catch (error) {
    return { ok: false, recoveryRequired, reason: String(error) };
  }
}

/** Rebuild from the durable IDs/counts when quest result processing overwrote the
 * engine's single backup. Preflight every category before changing any slot. */
function restoreDurable(pouch: REManagedObject, expected: InventorySnapshot, stacks?: Record<string, { id: number; n: number }[]>): void {
  const work: { slots: REManagedObject[]; items: { id: number; n: number }[] }[] = [];
  for (const t of RESTORE_TYPES) {
    const list = pouch.call("getInventoryDataList", t) as REManagedObject;
    const count = list.call("get_Count") as number;
    const items = stacks?.[String(t)] ?? Object.entries(expected[String(t)] ?? {}).map(([id, n]) => ({ id: Number(id), n }));
    if (!Number.isInteger(count) || count < items.length || count > 10000) throw new Error("Pouch restore capacity mismatch");
    if (items.some((x) => !Number.isInteger(x.id) || x.id <= 0 || !Number.isInteger(x.n) || x.n <= 0)) throw new Error("Invalid original pouch journal");
    const counts: Record<string, number> = {};
    for (const item of items) counts[String(item.id)] = (counts[String(item.id)] ?? 0) + item.n;
    const group = expected[String(t)]!;
    if (Object.keys(counts).length !== Object.keys(group).length || Object.keys(counts).some(id => counts[id] !== group[id]))
      throw new Error("Original pouch stacks differ from the recorded item totals");
    const slots: REManagedObject[] = [];
    for (let i = 0; i < count; i++) {
      const slot = list.call("get_Item", i) as REManagedObject;
      if (!slot || !slot.get_type_definition().get_method("setEmpty") ||
          !slot.get_type_definition().get_method("add(snow.data.ContentsIdSystem.ItemId, System.UInt32)")) throw new Error("Pouch restore API unavailable");
      slots.push(slot);
    }
    work.push({ slots, items });
  }
  for (const group of work) {
    for (const slot of group.slots) slot.call("setEmpty");
    group.items.forEach((item, i) => group.slots[i]!.call("add(snow.data.ContentsIdSystem.ItemId, System.UInt32)", item.id, item.n));
  }
}

interface PouchJournal { schema?: number; active: boolean; owner?: RecoveryOwner; items: InventorySnapshot;
  categoryTotals: number[]; stacks?: Record<string, { id: number; n: number }[]>; restoredProcess?: string }

export function endPouchIsolation(retainUntilSave = false): PouchSnapshot {
  const pouch = itemPouch();
  if (!pouch) return { ok: false, reason: "Item pouch unavailable" };
  try {
    const journal = readRecoveryRecord<PouchJournal>(SNAPSHOT_FILE);
    if (!journal?.active) {
      if (isolationActive) throw new Error("Original pouch journal unavailable; recovery retained");
      return { ok: true };
    }
    assertRecoveryOwner(journal.owner);
    if (journal.schema !== 2) throw new Error("旧道具袋恢复格式需要核对迁移，原备份保留");
    const expected = journal.items;
    validateSnapshot(expected, journal.categoryTotals);
    // Reading the live pouch must succeed even after Reset scripts or a restart.
    if (!sameSnapshot(expected, inventorySnapshot(pouch, false))) {
      let backup: InventorySnapshot | null = null;
      try { backup = inventorySnapshot(pouch, true); } catch { /* Durable journal remains authoritative. */ }
      if (backup && sameSnapshot(expected, backup)) pouch.call("loadFromBackupInventory", true);
      else restoreDurable(pouch, expected, journal.stacks);
    }
    if (!sameSnapshot(expected, inventorySnapshot(pouch, false))) throw new Error("Pouch item IDs/counts do not match original; recovery retained");
    journal.restoredProcess = readRecoveryOwner().process;
    if (rejson.dump_file(SNAPSHOT_FILE, retainUntilSave ? journal : { active: false }, 2) !== true)
      throw new Error("Cannot persist pouch recovery");
    isolationActive = false;
    return { ok: true };
  } catch (error) {
    return { ok: false, recoveryRequired: true, reason: String(error) };
  }
}

export function pouchCommitRecord(): PouchJournal | null | undefined {
  const journal=readRecoveryRecord<PouchJournal>(SNAPSHOT_FILE);
  if (!journal?.active) return null;
  const owner=assertRecoveryOwner(journal.owner);
  if (journal.restoredProcess!==owner.process) return undefined;
  if (journal.schema!==2) throw new Error("Original pouch save format unavailable");
  validateSnapshot(journal.items,journal.categoryTotals);
  const pouch=itemPouch();
  if (!pouch || !sameSnapshot(journal.items,inventorySnapshot(pouch,false)))
    throw new Error("Restored pouch changed before native save");
  return journal;
}

export function retirePouchCommit(): boolean {
  return rejson.dump_file(SNAPSHOT_FILE,{active:false},2)===true;
}
