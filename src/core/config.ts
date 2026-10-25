/**
 * 配置模型 —— 自 MhwRogue.Core/Config.cs 移植。
 * 数值唯一真源是 data/rogue_config.json；本文件只定义形状与校验。
 */

import { DEFAULT_RUNTIME, type RuntimeSettings } from "./quest_plan";

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
  runtime?: RuntimeSettings;
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
  // The shared JSON retains the C# PascalCase schema. Normalize at the boundary,
  // including runtime overrides; reward type identifiers (A/B/C/D/AU) are keys.
  const normalized = normalizeConfigKeys(raw);
  const fail = (what: string): never => {
    throw new Error(`rogue_config 缺失或非法: ${what}`);
  };
  const object = (value: unknown, path: string): Record<string, unknown> => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) fail(path);
    return value as Record<string, unknown>;
  };
  const array = (value: unknown, path: string, nonempty = false): unknown[] => {
    if (!Array.isArray(value) || (nonempty && value.length === 0)) fail(path);
    return value as unknown[];
  };
  const text = (value: unknown, path: string): string => {
    if (typeof value !== "string" || value.trim().length === 0) fail(path);
    return value as string;
  };
  const number = (value: unknown, path: string, min: number, integer = false): number => {
    if (typeof value !== "number" || !Number.isFinite(value) || value < min ||
        (integer && !Number.isInteger(value))) fail(path);
    return value as number;
  };
  const strings = (value: unknown, path: string, nonempty = false): string[] => {
    const values = array(value, path, nonempty);
    for (let i = 0; i < values.length; i++) text(values[i], `${path}[${i}]`);
    return values as string[];
  };

  const c = object(normalized, "root");
  number(c.startPt, "startPt", 0, true);
  number(c.maxCarts, "maxCarts", 1, true);
  number(c.cartRestorePrice, "cartRestorePrice", 0, true);
  number(c.cartRestoreLimit, "cartRestoreLimit", 0, true);
  number(c.choiceCount, "choiceCount", 1, true);
  strings(c.armorOptions, "armorOptions", true);

  const scaling = object(c.scaling, "scaling");
  for (const key of ["hpBase", "hpCap", "dmgBase", "dmgCap", "dualCompensation",
    "ultimateHpFactor", "mp2Hp", "mp34Hp", "mp34Dmg"]) {
    if (number(scaling[key], `scaling.${key}`, 0) === 0) fail(`scaling.${key}`);
  }
  for (const key of ["hpPerLayer", "dmgPerLayer"]) number(scaling[key], `scaling.${key}`, 0);
  if ((scaling.hpCap as number) < (scaling.hpBase as number)) fail("scaling.hpCap");
  if ((scaling.dmgCap as number) < (scaling.dmgBase as number)) fail("scaling.dmgCap");
  const reward = object(c.reward, "reward");
  for (const key of ["weakBase", "strongBase", "advBase", "ultimateBase"]) {
    number(reward[key], `reward.${key}`, 0, true);
  }
  const multipliers = object(c.typeRewardMul, "typeRewardMul");
  for (const key of ["A", "B", "C", "D", "AU"]) number(multipliers[key], `typeRewardMul.${key}`, 0);

  const quest = object(c.quest, "quest");
  number(quest.id, "quest.id", 1, true);
  number(quest.baseId, "quest.baseId", 1, true);
  number(quest.mapNo, "quest.mapNo", 1, true);
  if (quest.id === quest.baseId) fail("quest.id must differ from baseId");

  const runtime = c.runtime === undefined ? { ...DEFAULT_RUNTIME } : object(c.runtime, "runtime");
  if (runtime.route !== "reentry" && runtime.route !== "inPlace") fail("runtime.route");
  if (runtime.spawnMode !== "sequential" && runtime.spawnMode !== "simultaneous") fail("runtime.spawnMode");
  if (typeof runtime.autoPost !== "boolean") fail("runtime.autoPost");
  for (const key of ["pollSeconds", "spawnTimeoutSeconds", "campRadius", "postTimeoutSeconds"]) {
    if (number((runtime as unknown as Record<string, unknown>)[key], `runtime.${key}`, 0) === 0) fail(`runtime.${key}`);
  }
  for (const key of ["carveSeconds", "campDwellSeconds"]) {
    number((runtime as unknown as Record<string, unknown>)[key], `runtime.${key}`, 0);
  }
  c.runtime = runtime;

  const shop = array(c.shop, "shop", true);
  const shopIds: string[] = [];
  for (let i = 0; i < shop.length; i++) {
    const path = `shop[${i}]`;
    const item = object(shop[i], path);
    const id = text(item.id, `${path}.id`);
    if (shopIds.includes(id)) fail(`${path}.id (duplicate)`);
    shopIds.push(id);
    text(item.name, `${path}.name`);
    text(item.category, `${path}.category`);
    number(item.price, `${path}.price`, 0, true);
    if (!["perUnit", "fill", "service"].includes(item.mode as string)) fail(`${path}.mode`);
    number(item.cap, `${path}.cap`, item.mode === "service" ? 0 : 1, true);
    if (item.desc !== undefined) text(item.desc, `${path}.desc`);
    if (item.globalLimit !== undefined) number(item.globalLimit, `${path}.globalLimit`, 0, true);
  }

  const rules = array(c.unlockChain, "unlockChain");
  for (let i = 0; i < rules.length; i++) {
    const path = `unlockChain[${i}]`;
    const rule = object(rules[i], path);
    text(rule.monster, `${path}.monster`);
    text(rule.requiresKilling, `${path}.requiresKilling`);
    if (rule.monster === rule.requiresKilling) fail(`${path}.requiresKilling`);
  }

  const pools = array(c.pools, "pools", true);
  let nextLayer = 1;
  for (let i = 0; i < pools.length; i++) {
    const path = `pools[${i}]`;
    const pool = object(pools[i], path);
    const from = number(pool.from, `${path}.from`, 1, true);
    const to = number(pool.to, `${path}.to`, from, true);
    if (from !== nextLayer) fail(`${path}.from (gap or overlap)`);
    nextLayer = to + 1;
    if (!["low", "mid", "adv", "ultimate"].includes(pool.tier as string)) fail(`${path}.tier`);
    strings(pool.weak, `${path}.weak`, pool.tier !== "ultimate");
    const strong = pool.strong === null ? [] : strings(pool.strong, `${path}.strong`);
    const ultimate = pool.ultimate === null ? [] : strings(pool.ultimate, `${path}.ultimate`);
    const types = strings(pool.types, `${path}.types`, true);
    for (const type of types) {
      if (!["A", "B", "C", "D"].includes(type)) fail(`${path}.types`);
      if ((type === "C" || type === "D") && strong.length === 0) fail(`${path}.strong`);
    }
    if (pool.tier === "ultimate" && ultimate.length === 0) {
      fail(`${path}.ultimate`);
    }
  }
  return c as unknown as RogueConfig;
}

function normalizeConfigKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeConfigKeys);
  if (value === null || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    const normalized = ["A", "B", "C", "D", "AU"].includes(key)
      ? key : key.charAt(0).toLowerCase() + key.slice(1);
    result[normalized] = normalizeConfigKeys((value as Record<string, unknown>)[key]);
  }
  return result;
}
