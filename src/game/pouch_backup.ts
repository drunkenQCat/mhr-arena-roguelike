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
 * 已知边界（design doc §4.1，均未实测）：
 * - 原生备份是进程内状态，不解决崩溃恢复——正式隔离仍需自有带标识的恢复记录；
 * - 游戏可能在未知时点自动覆盖备份区；
 * - loadFromBackupInventory 的布尔参数语义（排除翔虫钥）按名推断，需实机确认。
 */

import { findTypeDefinition, getSingleton, relog, rejson, type REManagedObject, type RETypeDefinition } from "./sdk";

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

export function beginPouchIsolation(): PouchSnapshot {
  let recoveryRequired = false;
  try {
    if (isolationActive || (rejson.load_file(SNAPSHOT_FILE) as { active?: boolean } | null)?.active) return { ok: false, recoveryRequired: true, reason: "Pouch recovery already pending" };
    const pouch = itemPouch();
    if (!pouch) return { ok: false, recoveryRequired: false, reason: "Item pouch unavailable" };
    const table = inventoryTypesTable();
    if (table.Normal !== 0 || table.BulletBottle !== 2) return { ok: false, recoveryRequired: false, reason: "Inventory categories unavailable" };
    const original = inventorySnapshot(pouch, false);
    // A durable obligation exists before any native mutation.
    if (rejson.dump_file(SNAPSHOT_FILE, { active: true, items: original }, 2) !== true) return { ok: false, recoveryRequired: false, reason: "Cannot journal original pouch" };
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

export function endPouchIsolation(): PouchSnapshot {
  const pouch = itemPouch();
  if (!pouch) return { ok: false, reason: "Item pouch unavailable" };
  try {
    const journal = rejson.load_file(SNAPSHOT_FILE) as { active: boolean; items: InventorySnapshot } | null;
    const saved = journal?.active ? journal.items : null;
    const backup = inventorySnapshot(pouch, true);
    const expected = saved ?? backup; // legacy recovery records predate the durable snapshot
    if (!sameSnapshot(expected, backup)) throw new Error("Native backup changed; original pouch recovery retained");
    pouch.call("loadFromBackupInventory", true);
    if (!sameSnapshot(expected, inventorySnapshot(pouch, false))) throw new Error("Pouch item IDs/counts do not match original");
    if (rejson.dump_file(SNAPSHOT_FILE, { active: false }, 2) !== true) throw new Error("Cannot retire pouch journal");
    isolationActive = false;
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: String(error) };
  }
}
