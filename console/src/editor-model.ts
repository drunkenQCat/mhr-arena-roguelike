import { validateConfig, type RogueConfig } from "../../src/core/config";
import { RunCore } from "../../src/core/run_core";
import catalog from "../../data/monster_ids.json";

export { validateConfig };
export type { RogueConfig };
export const monsters = Object.entries(catalog).map(([en, value]) => ({ en, name: value.cn, id: value.id }))
  .sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));

export function parameterLabel(path: string): string {
  const labels: Record<string, string> = { startPt: "开局 PT", maxCarts: "猫车总次数", cartRestorePrice: "猫车恢复价格",
    cartRestoreLimit: "猫车恢复限购", armorOptions: "开局方案", scaling: "难度曲线", hpBase: "首层血量",
    hpPerLayer: "每层血量增量", hpCap: "血量上限", dmgBase: "首层伤害", dmgPerLayer: "每层伤害增量",
    dmgCap: "伤害上限", dualCompensation: "双怪血量系数", ultimateHpFactor: "极强怪血量系数",
    mp2Hp: "双人血量", mp34Hp: "三/四人血量", mp34Dmg: "三/四人伤害", reward: "基础奖励",
    weakBase: "弱怪 PT", strongBase: "强怪 PT", advBase: "高阶怪 PT", ultimateBase: "极强怪 PT",
    typeRewardMul: "组合奖励倍率", simultaneousBalance: "同时双怪补偿", hp: "血量", damage: "伤害",
    pools: "怪物池", from: "起始层", to: "结束层", tier: "梯度", types: "组合类型", weak: "弱怪池",
    strong: "强怪池", ultimate: "极强怪池", shop: "商店", price: "价格", cap: "持有上限", globalLimit: "全局限购",
    runtime: "流程节奏", pollSeconds: "采样间隔", carveSeconds: "剥取等待", campRadius: "集结半径",
    campDwellSeconds: "集结停留时间", spawnTimeoutSeconds: "出怪超时", postTimeoutSeconds: "接取超时",
    route: "默认路线", autoPost: "自动接取", unlockChain: "解锁规则", monster: "解锁怪物", requiresKilling: "前置讨伐" };
  return path.replace(/\[(\d+)\]/g, ".$1").split(".").map((p) => /^\d+$/.test(p) ? `第 ${Number(p) + 1} 项` : labels[p] ?? p).join(" / ");
}

export function editorConfig(raw: unknown): RogueConfig {
  const copy = JSON.parse(JSON.stringify(raw)) as Record<string, unknown>;
  // REFramework serializes empty Lua arrays as null. Repair this transport shape here,
  // rather than weakening the required-field contract of the shared validator.
  if (copy && typeof copy === "object") {
    if (copy.UnlockChain === null) copy.UnlockChain = [];
    if (copy.unlockChain === null) copy.unlockChain = [];
  }
  const cfg = validateConfig(copy);
  if(cfg.effectShop){
    cfg.effectShop.products??=[];
    for(const p of cfg.effectShop.products){p.conditions.weapons??=[];p.conditions.exclusiveGroups??=[];}
  }
  cfg.simultaneousBalance ??= { hp: 0.9, damage: 0.95, reward: 1.15 };
  return cfg;
}

export function preview(raw: unknown, layer: number, players: number, unlockAll = false, seed = 42) {
  const cfg = editorConfig(raw);
  if (!Number.isInteger(layer) || layer < 1 || layer > (cfg.pools.at(-1)?.to ?? 0))
    throw new Error('预览层数必须是怪池范围内的整数');
  if (![1, 2, 3, 4].includes(players)) throw new Error('预览人数须为 1 至 4 人');
  const core = new RunCore(cfg, seed);
  core.startRun(cfg.armorOptions[0]!);
  core.state.layer = layer;
  if (unlockAll) core.state.killedUltimates = cfg.unlockChain.map((r) => r.requiresKilling);
  return core.generateChoices(players);
}

/** Fixed seeds make draft comparisons repeatable; samples are not exact probabilities. */
export function sampleBalance(raw: unknown, layer: number, players: number, unlockAll = false) {
  const groups = new Map<string, { mode: string; count: number; minPt: number; maxPt: number; totalPt: number; minHp: number; maxHp: number }>();
  for (let i = 0; i < 24; i++) {
    for (const choice of preview(raw, layer, players, unlockAll, 42 + i * 7919)) {
      const mode = choice.mode ?? 'single';
      const group = groups.get(mode) ?? { mode, count: 0, minPt: Infinity, maxPt: -Infinity, totalPt: 0, minHp: Infinity, maxHp: -Infinity };
      group.count++;
      group.minPt = Math.min(group.minPt, choice.rewardPt); group.maxPt = Math.max(group.maxPt, choice.rewardPt);
      group.totalPt += choice.rewardPt;
      group.minHp = Math.min(group.minHp, choice.hpMul); group.maxHp = Math.max(group.maxHp, choice.hpMul);
      groups.set(mode, group);
    }
  }
  return [...groups.values()].map(group => ({ ...group, meanPt: group.totalPt / group.count }));
}

export function changes(before: unknown, after: unknown, prefix = ""): { path: string; before: unknown; after: unknown }[] {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  if (before === null || after === null || typeof before !== "object" || typeof after !== "object")
    return [{ path: prefix, before, after }];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].flatMap((key) => changes((before as Record<string, unknown>)[key],
    (after as Record<string, unknown>)[key], prefix ? `${prefix}.${key}` : key));
}

export function poolIssues(config: RogueConfig): string[] {
  const known = new Set(monsters.flatMap((m) => [m.en, m.name]));
  const issues: string[] = [];
  for (const [index, pool] of config.pools.entries()) {
    for (const name of [...pool.weak, ...(pool.strong ?? []), ...(pool.ultimate ?? [])])
      if (!known.has(name)) issues.push(`怪池 ${index + 1}：${name} 不在当前 Rise 怪物目录中`);
  }
  for (const rule of config.unlockChain) {
    if (!known.has(rule.monster) || !known.has(rule.requiresKilling)) issues.push("解锁规则中存在未选择或未知怪物");
  }
  return issues;
}
