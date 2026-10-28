/**
 * 原生猫车计数服务 —— 文档 §5.2：猫车恢复不能只加 Core 一点。
 * Rise 的任务失败判定走 QuestManager 内部的 DeathNum（原生三猫），
 * 若只改 Core.CartsLeft，下一次原生死亡仍会按原生阈值结束任务。
 *
 * 方案（文档建议的"原生计数减一"）：购买猫车恢复时把原生 getDeathNum()
 * 减 1 写回（setDeathNum），Core 侧加 1——两边保持一致。
 * 全部方法签名经 sdk-dump 核实（getDeathNum/setDeathNum 均为实例方法）。
 *
 * 已知边界（design doc §5.2，未实测项）：
 * - notifyDeath 内部是否还维护其他状态（每次死亡是否有副作用计数）；
 * - 多人时死亡数是否广播同步（M6 前仅单机使用）；
 * - setDeathNum(0) 是否会解锁已触发的 setQuestFail——恢复必须在下一次
 *   死亡发生前调用（我们只在 Prep/Selecting 整备期卖，满足前提）。
 */

import { getSingleton, relog, type REManagedObject } from "./sdk";

function questManager(): REManagedObject | null {
  return getSingleton("snow.QuestManager");
}

export interface NativeCartReport {
  ok: boolean;
  before?: number;
  after?: number;
  reason?: string;
}

/** 读原生死亡计数（= 已消耗猫车数）。 */
export function nativeDeathNum(): number | null {
  const qm = questManager();
  if (!qm) return null;
  try {
    const n = qm.call("getDeathNum") as number;
    return Number.isInteger(n) && n >= 0 ? n : null;
  } catch { return null; }
}

/**
 * 猫车恢复：原生死亡计数减一。只在整备期（无进行中死亡流程）调用。
 * 不主动触碰 setQuestFail/notifyDeath——那两个属于失败链，误用会直接结束任务。
 */
export function restoreNativeCart(): NativeCartReport {
  const qm = questManager();
  if (!qm) return { ok: false, reason: "QuestManager unavailable" };
  try {
    const before = qm.call("getDeathNum") as number;
    if (!Number.isInteger(before) || before <= 0) {
      return { ok: false, before, reason: "原生死亡计数为 0，无需恢复" };
    }
    qm.call("setDeathNum", before - 1);
    const after = qm.call("getDeathNum") as number;
    const ok = after === before - 1;
    if (!ok) relog.error(`[MhwRogue] native cart restore mismatch: ${before} -> ${after}`);
    return { ok, before, after, reason: ok ? undefined : "setDeathNum 读回不一致" };
  } catch (error) {
    relog.error(`[MhwRogue] native cart restore threw: ${String(error)}`);
    return { ok: false, reason: String(error) };
  }
}
