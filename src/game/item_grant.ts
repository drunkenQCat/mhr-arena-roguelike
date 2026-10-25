/**
 * 道具发放 —— M3 核心：把 Core 商店买的物品写进玩家道具袋。
 * 链路（全部经 2026-10-25 实机 dump 核实）：
 *   snow.data.DataManager._ItemPouch (snow.data.ItemPouch)
 *     .tryAddGameItem(itemId: snow.data.ContentsIdSystem.ItemId, addNum: int)
 *   ItemId 是 UInt32 枚举，data/item_ids.json 的整数值可直接传（Potion=0x04100006 已验证）。
 * 安全规则：只在任务外（村庄）调用；翻页/排序由游戏自己处理。
 */

import { itemIds } from "./default_config";
import { findTypeDefinition, getSingleton, relog, type REManagedObject } from "./sdk";

/** 商店 id → 游戏道具数值（default_config 内嵌；data/item_ids.json 的生成源）。 */
export function gameIdOf(shopItemId: string): number | null {
  return itemIds[shopItemId]?.id ?? null;
}

/** 商店 id → 游戏道具名（日志/HUD 显示用）。 */
export function gameNameOf(shopItemId: string): string | null {
  return itemIds[shopItemId]?.name ?? null;
}

/** 道具袋句柄。村庄里 DataManager 常驻；任务中也能拿到但我们只在整备期发放。 */
function itemPouch(): REManagedObject | null {
  const dm = getSingleton("snow.data.DataManager");
  if (!dm) return null;
  return (dm.get_field("_ItemPouch") as REManagedObject | null) ?? null;
}

export interface GrantReport {
  shopItemId: string;
  gameName: string;
  requested: number;
  granted: boolean;
}

/** 把一个 Core 商品写入道具袋。返回是否成功（数量上限由调用方——Core 的 Cap——保证）。 */
export function grantItem(shopItemId: string, count: number): GrantReport {
  const gameId = gameIdOf(shopItemId);
  const gameName = gameNameOf(shopItemId) ?? shopItemId;
  const base: GrantReport = { shopItemId, gameName, requested: count, granted: false };
  if (gameId === null) {
    relog.warn(`[MhwRogue] 无 ${shopItemId} 的游戏道具 ID 映射`);
    return base;
  }
  const pouch = itemPouch();
  if (!pouch) {
    relog.warn("[MhwRogue] DataManager/_ItemPouch 不可用（未进村？）");
    return base;
  }
  try {
    pouch.call("tryAddGameItem", gameId, count);
    relog.info(`[MhwRogue] granted ${gameName} x${count} (id 0x${gameId.toString(16)})`);
    return { ...base, granted: true };
  } catch (e) {
    relog.error(`[MhwRogue] tryAddGameItem 失败 ${gameName}: ${e}`);
    return base;
  }
}

/** 批量发货（购买结算用）；全部成功才返回 true。 */
export function grantAll(items: Array<{ shopItemId: string; count: number }>): boolean {
  return items.map((it) => grantItem(it.shopItemId, it.count)).every((r) => r.granted);
}

// 保留引用：SDK 导入即用（findTypeDefinition 留给后续"读袋内容做校验"用，避免 tree-shake）
void findTypeDefinition;
