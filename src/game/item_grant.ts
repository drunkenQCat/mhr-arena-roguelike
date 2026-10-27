/**
 * 道具发放 —— M3 核心：把 Core 商店买的物品写进玩家道具袋。
 * 链路（全部经 2026-10-25 实机 dump 核实）：
 *   snow.data.DataManager._ItemPouch (snow.data.ItemPouch)
 *     .tryAddGameItem(itemId: snow.data.ContentsIdSystem.ItemId, addNum: int)
 *   ItemId 是 UInt32 枚举，data/item_ids.json 的整数值可直接传（Potion=0x04100006 已验证）。
 * 村庄整备或已清波的单人自定义斗技场发放单件；调用返回 void，必须读回数量验证。
 */

import { itemIds } from "./default_config";
import { getSingleton, relog, type REManagedObject } from "./sdk";

// Bare-name dispatch may select the other overload and reject two arguments without throwing.
const ADD_ITEM = "tryAddGameItem(snow.data.ContentsIdSystem.ItemId, System.Int32)";

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
  before?: number;
  after?: number;
  uncertain?: boolean;
  method?: string;
  reason?: string;
}

/** Native add returns void: only a count delta proves delivery. */
export function pouchCount(shopItemId: string): number {
  const id = gameIdOf(shopItemId);
  const pouch = itemPouch();
  if (id === null || !pouch) throw new Error("Item mapping/pouch unavailable");
  const slot = pouch.call("findInventoryData", id) as REManagedObject | null;
  const count = slot ? slot.call("get_Count") as number : 0;
  if (!Number.isInteger(count) || count < 0) throw new Error("Invalid native item count");
  return count;
}

export interface TradeQuest { questId: number; questUnique: number }

/** An arena context is supplied only by the session's between-wave Selecting stage. */
export function canTrade(context?: TradeQuest): boolean {
  try {
    const qm = getSingleton("snow.QuestManager");
    const stage = getSingleton("snow.stage.StageManager");
    const gui = getSingleton("snow.gui.GuiManager");
    if (!qm || !stage || !gui || stage.call("get_IsQuestOnline") || gui.call("isOpenYNInfo") || gui.call("isOpenSelectInfo")) return false;
    if (!qm.call("isActiveQuest")) return !!gui.call("IsCanInvokeQuestBoard");
    if (!context || context.questId !== 900102 || qm.call("get_ActiveQuestNo") !== context.questId ||
        qm.call("getActiveQuestUniqueNo") !== context.questUnique || qm.call("isPlayQuest") !== true) return false;
    const em = getSingleton("snow.enemy.EnemyManager");
    if (!em) return false;
    const count = em.call("getBossEnemyCount") as number;
    if (!Number.isInteger(count) || count < 0 || count > 64) return false;
    for (let i = 0; i < count; i++) {
      const e = em.call("getBossEnemy", i) as REManagedObject | null;
      if (!e || (!e.call("isDieBehaviorActive") && !e.call("isCapture"))) return false;
    }
    return true;
  } catch { return false; }
}

/** 单件发货。调用前检查游戏容量；granted 表示数量确实增加了一件。 */
export function grantItem(shopItemId: string, count: number, context?: TradeQuest): GrantReport {
  const gameId = gameIdOf(shopItemId);
  const gameName = gameNameOf(shopItemId) ?? shopItemId;
  const base: GrantReport = { shopItemId, gameName, requested: count, granted: false, method: ADD_ITEM };
  if (gameId === null) {
    relog.warn(`[MhwRogue] 无 ${shopItemId} 的游戏道具 ID 映射`);
    return base;
  }
  if (!Number.isInteger(count) || count !== 1) return base;
  const pouch = itemPouch();
  if (!pouch) {
    relog.warn("[MhwRogue] DataManager/_ItemPouch 不可用（未进村？）");
    return base;
  }
  let before: number;
  try {
    if (!pouch.get_type_definition().get_method(ADD_ITEM)) {
      return { ...base, reason: "Required two-argument native overload is unavailable" };
    }
    if (!canTrade(context) || pouch.call("canAddItem", gameId) !== true) return base;
    before = pouchCount(shopItemId);
  } catch { return base; }
  try { pouch.call(ADD_ITEM, gameId, count); }
  catch (error) { relog.error(`[MhwRogue] native grant threw; checking delivery: ${String(error)}`); }
  // Even a throwing call may have mutated the pouch. Never blindly retry.
  try {
    const after = pouchCount(shopItemId);
    return { ...base, before, after, granted: after - before === count,
      uncertain: after !== before && after - before !== count };
  } catch { return { ...base, before, uncertain: true }; }
}
