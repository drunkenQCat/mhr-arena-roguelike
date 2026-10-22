/**
 * 配置模型 —— 自 MhwRogue.Core/Config.cs 移植。
 * 数值唯一真源是 data/rogue_config.json；本文件只定义形状与校验。
 */

export type QuestType = "A" | "B" | "C" | "D";
/** AU = 极强怪高阶单怪（V1.3 §2.2），仅出现在 ultimate 层。 */
export type RewardType = QuestType | "AU";
export type PoolTierName = "low" | "mid" | "adv" | "ultimate";
export type ShopMode = "perUnit" | "fill" | "service";

export interface ShopItem {
  id: string;
  name: string;
  category: string;
  price: number;
  /** 持有上限；service 类无容量语义，填 0。 */
  cap: number;
  mode: ShopMode;
  desc?: string;
  /** 全局限购次数（如猫车恢复 1 次）。 */
  globalLimit?: number;
}

export interface PoolTier {
  from: number;
  to: number;
  tier: PoolTierName;
  weak: string[];
  strong: string[] | null;
  ultimate: string[] | null;
  types: QuestType[];
}

export interface RewardSpec {
  weakBase: number;
  strongBase: number;
  advBase: number;
  ultimateBase: number;
}

export interface ScalingSpec {
  hpBase: number;
  hpPerLayer: number;
  hpCap: number;
  dmgBase: number;
  dmgPerLayer: number;
  dmgCap: number;
  /** 双怪任务单体血量补偿（V1.3 §1.3）。 */
  dualCompensation: number;
  /** 极强怪血量额外系数（V1.3 §2.3）。 */
  ultimateHpFactor: number;
  mp2Hp: number;
  mp34Hp: number;
  mp34Dmg: number;
}

/** 讨伐 requiresKilling 之后才解锁 monster（如：爵银龙 → 冥渊龙）。 */
export interface UnlockRule {
  monster: string;
  requiresKilling: string;
}

/** 入口斗技场任务的注册参数（对应 free_arena 原型）。 */
export interface QuestSpec {
  id: number;
  baseId: number;
  mapNo: number;
}

export interface RogueConfig {
  startPt: number;
  maxCarts: number;
  cartRestorePrice: number;
  cartRestoreLimit: number;
  choiceCount: number;
  scaling: ScalingSpec;
  reward: RewardSpec;
  typeRewardMul: Record<RewardType, number>;
  armorOptions: string[];
  pools: PoolTier[];
  shop: ShopItem[];
  quest: QuestSpec;
  unlockChain: UnlockRule[];
}

export function baseReward(reward: RewardSpec, tier: string): number {
  switch (tier) {
    case "weak":
      return reward.weakBase;
    case "strong":
      return reward.strongBase;
    case "adv":
      return reward.advBase;
    case "ultimate":
      return reward.ultimateBase;
    default:
      return reward.weakBase;
  }
}

/** 运行时配置校验：缺字段立即失败，不允许半配置进游戏。 */
export function validateConfig(raw: unknown): RogueConfig {
  const c = raw as Partial<RogueConfig>;
  const fail = (what: string): never => {
    throw new Error(`rogue_config 缺失或非法: ${what}`);
  };
  if (typeof c.startPt !== "number") fail("startPt");
  if (typeof c.maxCarts !== "number") fail("maxCarts");
  if (typeof c.cartRestorePrice !== "number") fail("cartRestorePrice");
  if (typeof c.cartRestoreLimit !== "number") fail("cartRestoreLimit");
  if (typeof c.choiceCount !== "number") fail("choiceCount");
  if (!c.scaling || typeof c.scaling.hpBase !== "number") fail("scaling");
  if (!c.reward || typeof c.reward.weakBase !== "number") fail("reward");
  if (!c.typeRewardMul || typeof c.typeRewardMul.A !== "number") fail("typeRewardMul");
  if (!Array.isArray(c.armorOptions) || c.armorOptions.length === 0) fail("armorOptions");
  if (!Array.isArray(c.pools) || c.pools.length === 0) fail("pools");
  if (!Array.isArray(c.shop) || c.shop.length === 0) fail("shop");
  if (!c.quest || typeof c.quest.id !== "number") fail("quest");
  return raw as RogueConfig;
}
