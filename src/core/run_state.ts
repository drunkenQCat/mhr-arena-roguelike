/**
 * 一局状态（纯 DTO）—— 自 MhwRogue.Core/RunState.cs 移植。
 * record → interface；联机时这就是同步载荷，保持可 JSON 序列化。
 */

export type RunPhase = "Idle" | "Prep" | "Choosing" | "Combat" | "Carve" | "GameOver";

export interface OwnedItem {
  id: string;
  count: number;
}

export type WaveMode = "single" | "sequential" | "simultaneous";

export interface WaveOption {
  mode?: WaveMode;
  index: number;
  typeTag: string;
  label: string;
  monsters: string[];
  tier: string;
  rewardMul: number;
  hpMul: number;
  dmgMul: number;
  rewardPt: number;
}

export interface PlayerWallet {
  pt: number;
  bag: OwnedItem[];
  purchaseLog: string[];
}

export interface RunState {
  phase: RunPhase;
  layer: number;
  cartsLeft: number;
  armor: string | null;
  wallet: PlayerWallet;
  currentChoices: WaveOption[];
  activeWave: WaveOption | null;
  cartRestoreUsed: boolean;
  /** 本局讨伐过的极强怪（解锁链判定依据）。 */
  killedUltimates: string[];
  /** 环形日志，最新在前。 */
  log: string[];
}

export function createState(startPt: number, maxCarts: number): RunState {
  return {
    phase: "Idle",
    layer: 0,
    cartsLeft: maxCarts,
    armor: null,
    wallet: { pt: startPt, bag: [], purchaseLog: [] },
    currentChoices: [],
    activeWave: null,
    cartRestoreUsed: false,
    killedUltimates: [],
    log: [],
  };
}

export function countOf(wallet: PlayerWallet, id: string): number {
  for (const slot of wallet.bag) {
    if (slot.id === id) return slot.count;
  }
  return 0;
}

/** record with 语义：返回替换/追加了某物品的新背包。 */
export function replaceOrAdd(bag: OwnedItem[], id: string, count: number): OwnedItem[] {
  const rest = bag.filter((b) => b.id !== id);
  rest.push({ id, count });
  return rest;
}
