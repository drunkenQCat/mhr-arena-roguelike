/**
 * 装备抽取服务 —— V1.3 §3.6 初级/中级/高级/顶级抽取。
 * 发放链路复用 equip_wear.grantEquip（显式重载名 + 读回裁决，2026-10-29 实测）。
 * 追踪与清理：发件追加进 equip_wear 的 startup 持久化记录，局末 restoreStartup 统一
 * subEquipment（先恢复原装再删本局条目；玩家中途卖掉则跳过，不阻塞）。
 * 本类不抛异常；失败进报告，交由商店事务层回滚 PT。
 */

import { getSingleton, relog, type REManagedObject } from "./sdk";
import type { GachaEntry, GachaPoolSpec } from "../core/config";
import { grantEquip, appendGrantedEntry } from "./equip_wear";

export interface GachaRollResult {
  ok: boolean;
  uncertain?: boolean;
  /** 游戏内名字（EquipmentInventoryData.getName，实测可用），日志/播报用。 */
  name?: string;
  kind?: "weapon" | "armor";
  id?: number;
  boxIndex?: number;
  /** true=玩家已有该装备，复用未新发（绝不能进局末清理清单）。 */
  reused?: boolean;
  reason?: string;
}

export interface GachaDeps {
  /** 确定性加权抽取（RunCore.rollWeighted）；返回 -1 = 无可用权重。 */
  rollIndex(weights: number[]): number;
}

function equipmentBox(): REManagedObject | null {
  const dm = getSingleton("snow.data.DataManager");
  if (!dm) return null;
  try {
    return (dm.get_field("_PlEquipBox") as REManagedObject | null) ??
      (dm.call("getEquipBox") as REManagedObject | null);
  } catch {
    return null;
  }
}

function entryName(entry: REManagedObject | null): string | null {
  if (!entry) return null;
  try {
    const v = entry.call("getName") as string;
    return typeof v === "string" && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

/** 发放后按 id 找回条目对象（grantEquip 只回索引；名字读回需要对象本身）。 */
function findEntryObject(box: REManagedObject, idVal: number, idType: number): REManagedObject | null {
  try {
    const list = box.get_field("_WeaponArmorInventoryList") as REManagedObject | null;
    if (!list) return null;
    const count = list.call("get_Count") as number;
    for (let i = 0; i < count; i++) {
      const e = list.call("get_Item", i) as REManagedObject | null;
      if (!e) continue;
      if ((e.get_field("_IdVal") as number) === idVal && (e.get_field("_IdType") as number) === idType) return e;
    }
  } catch { /* 名字读不到不影响交付 */ }
  return null;
}

export class GachaService {
  constructor(private readonly pools: Record<string, GachaPoolSpec>, private readonly deps: GachaDeps) {}

  hasPool(poolId: string): boolean {
    const pool = this.pools[poolId];
    return !!pool && pool.entries.length > 0;
  }

  /** 抽一次并发放。调用前由商店事务层扣款；失败/不确定由调用方回滚。 */
  roll(poolId: string): GachaRollResult {
    const pool = this.pools[poolId];
    if (!pool || pool.entries.length === 0) return { ok: false, reason: `奖池 ${poolId} 未配置` };
    const weights = pool.entries.map((e) => e.w);
    const picked = this.deps.rollIndex(weights);
    if (picked < 0 || picked >= pool.entries.length) return { ok: false, reason: "奖池权重非法（全 0？）" };
    const entry: GachaEntry = pool.entries[picked]!;
    const box = equipmentBox();
    if (!box) return { ok: false, reason: "EquipBox unavailable" };
    const grant = grantEquip(box, entry.id, entry.kind, appendGrantedEntry);
    if (!grant.ok || grant.boxIndex === undefined) {
      return { ok: false, uncertain: grant.uncertain,
        reason: grant.reason ?? "发放未生效", kind: entry.kind, id: entry.id };
    }
    const name = entryName(findEntryObject(box, entry.id, entry.kind === "armor" ? 2 : 1));
    if (grant.reused) {
      relog.info(`[MhwRogue] 抽取复用已有装备: ${name ?? entry.id}`);
    } else {
      relog.info(`[MhwRogue] 抽取发放: ${name ?? entry.id}（箱位 ${grant.boxIndex}）`);
    }
    return { ok: true, name: name ?? undefined, kind: entry.kind, id: entry.id,
      boxIndex: grant.boxIndex, reused: grant.reused === true };
  }
}
