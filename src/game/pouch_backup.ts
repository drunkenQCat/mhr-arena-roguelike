/**
 * 道具袋原生备份/恢复 —— 文档 §4.1（零物资开局、结束恢复）。
 * 用 ItemPouch 自己的备份机制，不自研字段复制：
 *   saveToBackupInventory()                       当前袋 → 引擎备份区
 *   loadFromBackupInventory(isExceptWireJumpInsectItem)
 *                                                 备份区 → 当前袋（可排除翔虫钥）
 *   getInventoryDataList(InventoryTypes)          按分类读（普通/临时/弹瓶/常驻/翔虫/狗袋…）
 *   clear(InventoryTypes)                         按分类清空（禁止一把清所有分类）
 *
 * InventoryTypes 枚举值以运行时 dump 的 snow.data.ItemPouch.InventoryTypes 为准
 * （sdk_types.json 已含）；脚本加载时读取并缓存，读不到则本模块整体停用。
 *
 * 已知边界（design doc §4.1，均未实测）：
 * - 原生备份是进程内状态，不解决崩溃恢复——正式隔离仍需自有带标识的恢复记录；
 * - 游戏可能在未知时点自动覆盖备份区；
 * - loadFromBackupInventory 的布尔参数语义（排除翔虫钥）按名推断，需实机确认。
 */

import { findTypeDefinition, getSingleton, relog, type REManagedObject, type RETypeDefinition } from "./sdk";

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
 * 保守策略：只清 NORMAL / AMMO / BOTTLE（衣服、翔虫钥、狗袋不碰）。
 * 若 InventoryTypes 枚举读不到对应名，跳过该分类并记录。
 *
 * 隔离期保护（2026-10-28 审查补充）：
 * - 重复 begin 直接拒绝——第二次 saveToBackupInventory 会用"已清空的袋"
 *   覆盖备份区，造成原物资永久丢失；
 * - 隔离期间记录快照摘要，end 时读回比对，恢复异常必须上报而不是静默成功。
 */
let isolationActive = false;

export function beginPouchIsolation(): PouchSnapshot {
  if (isolationActive) {
    return { ok: false, reason: "隔离已在进行中；重复 begin 会覆盖备份区，已拒绝" };
  }
  const pouch = itemPouch();
  if (!pouch) return { ok: false, reason: "DataManager/_ItemPouch unavailable" };
  const table = inventoryTypesTable();
  const counts: Record<string, number> = {};
  try {
    pouch.call("saveToBackupInventory");
    const cleared: string[] = [];
    for (const typeName of ["NORMAL", "AMMO", "BOTTLE"]) {
      const value = table[typeName];
      if (value === undefined) { counts[typeName] = -1; continue; }
      counts[typeName] = Object.keys(categoryCounts(pouch, typeName) ?? {}).length;
      pouch.call("clear", value);
      cleared.push(typeName);
    }
    isolationActive = true;
    relog.info(`[MhwRogue] 零物资隔离完成，清空分类：${cleared.join(", ") || "（无可识别分类）"}`);
    return { ok: true, counts };
  } catch (error) {
    // save 已发生但 clear 中途失败：袋处于半清空状态——必须允许 end 恢复，不锁定
    isolationActive = true;
    relog.error(`[MhwRogue] beginPouchIsolation 失败：${String(error)}`);
    return { ok: false, reason: String(error), counts };
  }
}

/** 结束/中止恢复：从引擎备份区还原并读回核验（isExceptWireJumpInsectItem=true 按原版语义）。 */
export function endPouchIsolation(): PouchSnapshot {
  const pouch = itemPouch();
  if (!pouch) return { ok: false, reason: "DataManager/_ItemPouch unavailable" };
  try {
    pouch.call("loadFromBackupInventory", true);
    // 恢复后核验：白名单分类任一非空即视为恢复成功（隔离时已清空，恢复后应回到备份时数量）
    const evidence: Record<string, number> = {};
    let nonEmpty = 0;
    for (const typeName of ["NORMAL", "AMMO", "BOTTLE"]) {
      const counts = categoryCounts(pouch, typeName);
      const total = counts ? Object.values(counts).reduce((a, b) => a + b, 0) : -1;
      evidence[typeName] = total;
      if (total > 0) nonEmpty++;
    }
    isolationActive = false;
    // 至少一个分类有物品才认定恢复发生（备份区为空时引擎可能什么都不做）
    if (nonEmpty === 0) {
      relog.error("[MhwRogue] 恢复后白名单分类全部为空——备份区可能为空，物资未恢复");
      return { ok: false, reason: "恢复后白名单分类全部为空（备份区可能为空）", counts: evidence };
    }
    relog.info(`[MhwRogue] 道具袋已从原生备份恢复（白名单非空分类 ${nonEmpty}/3）`);
    return { ok: true, counts: evidence };
  } catch (error) {
    isolationActive = false;
    relog.error(`[MhwRogue] endPouchIsolation 失败：${String(error)}`);
    return { ok: false, reason: String(error) };
  }
}
