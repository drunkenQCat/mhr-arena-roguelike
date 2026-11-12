/**
 * 装备抽取服务 —— V1.3 §3.6 初级/中级/高级/顶级抽取。
 * 发放链路复用 equip_wear.grantEquip（显式重载名 + 读回裁决，2026-10-29 实测）。
 * 追踪与清理：发件追加进 equip_wear 的 startup 持久化记录，局末 restoreStartup 统一
 * subEquipment（先恢复原装再删本局条目；玩家中途卖掉则跳过，不阻塞）。
 * 本类不抛异常；失败进报告，交由商店事务层回滚 PT。
 */

import { getSingleton, relog, type REManagedObject } from "./sdk";
import type { GachaEntry, GachaPoolSpec } from "../core/config";
import { grantEquip, appendGrantedEntry, confirmGrantedEntry, grantRunJewel, runJewelName } from "./equip_wear";

export interface GachaRollResult {
  ok: boolean;
  uncertain?: boolean;
  /** 游戏内名字（EquipmentInventoryData.getName，实测可用），日志/播报用。 */
  name?: string;
  kind?: "weapon" | "armor" | "decoration";
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

export class GachaService {
  constructor(private pools: Record<string, GachaPoolSpec>, private readonly deps: GachaDeps) {}
  /** Called only before personal preparation, never during an in-flight purchase. */
  configure(pools: Record<string,GachaPoolSpec>): void { this.pools=pools; }

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
    if(entry.kind === "decoration") {
      let name:string;
      try {name=runJewelName(entry.id);}catch(error){return {ok:false,reason:String(error)};}
      try { grantRunJewel(entry.id);return {ok:true,name,kind:entry.kind,id:entry.id}; }
      catch(error){return {ok:false,uncertain:true,reason:String(error)};}
    }
    const box = equipmentBox();
    if (!box) return { ok: false, reason: "EquipBox unavailable" };
    const grant = grantEquip(box, entry.id, entry.kind, appendGrantedEntry, false, confirmGrantedEntry);
    if (!grant.ok || grant.boxIndex === undefined) {
      return { ok: false, uncertain: grant.uncertain,
        reason: grant.reason ?? "发放未生效", kind: entry.kind, id: entry.id };
    }
    let name: string | null = null;
    try { name = entryName((box.get_field("_WeaponArmorInventoryList") as REManagedObject | null)?.call("get_Item", grant.boxIndex) as REManagedObject | null); }
    catch { /* Delivery was already verified; a missing display name cannot refund it. */ }
    if (grant.reused) {
      relog.info(`[MhwRogue] 抽取复用已有装备: ${name ?? entry.id}`);
    } else {
      relog.info(`[MhwRogue] 抽取发放: ${name ?? entry.id}（箱位 ${grant.boxIndex}）`);
    }
    return { ok: true, name: name ?? undefined, kind: entry.kind, id: entry.id,
      boxIndex: grant.boxIndex, reused: grant.reused === true };
  }
}
