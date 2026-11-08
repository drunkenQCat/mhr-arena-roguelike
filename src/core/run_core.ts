/**
 * 一局规则引擎 —— 自 MhwRogue.Core/RunCore.cs 1:1 移植。
 * 纯逻辑、零游戏依赖：REFramework mod 与本地 vitest 共用同一实现。
 * 行为约定（含中文提示文案）与 C# 版逐条对应，测试守护这一等价性。
 */

import { baseReward, type PoolTier, type RewardType, type RogueConfig, type ShopItem } from "./config";
import { Rng } from "./rng";
import {
  countOf,
  createState,
  replaceOrAdd,
  type OwnedItem,
  type RunState,
  type WaveOption,
} from "./run_state";

const SIMULTANEOUS_BALANCE = { reward: 1.15, hp: 0.9, damage: 0.95 } as const;

export interface Result {
  ok: boolean;
  message: string | null;
}

export function ok(message?: string): Result {
  return { ok: true, message: message ?? null };
}

export function fail(message: string): Result {
  return { ok: false, message };
}

export interface ShopEntry {
  id: string;
  name: string;
  category: string;
  price: number;
  cap: number;
  owned: number;
  mode: string;
  desc: string | null;
  canBuy: boolean;
  reason: string | null;
}

/** Fields changed by buy(); keep rollback ownership here when adding services. */
export type PurchaseCheckpoint = Pick<RunState, "wallet" | "log" | "cartsLeft" | "cartRestoreUsed">;

type Tier = { tag: string; monsters: string[]; tier: string };

export class RunCore {
  private _config: RogueConfig;

  /** 当前生效配置（replaceConfig 可热替换：商店/池/倍率在下次取值生效） */
  get config(): RogueConfig { return this._config; }

  readonly state: RunState;
  private rng: Rng;

  constructor(config: RogueConfig, seed?: number) {
    this._config = config;
    this.rng = new Rng(seed);
    this.state = createState(config.startPt, config.maxCarts);
  }

  private log(msg: string): void {
    this.state.log.unshift(`[L${this.state.layer}] ${msg}`);
  }

  // ---------- 开局 / 结束 ----------

  /** 热替换配置（简报 §7 生效点：取值类即时、局规则下局生效）。 */
  replaceConfig(config: RogueConfig): void
  {
    this._config = config;
  }

  armorOptions(): string[] {
    return this.config.armorOptions;
  }

  abortRun(reason: string): void {
    this.state.phase = "GameOver";
    this.log(reason);
  }

  startRun(armor: string): Result {
    if (this.state.phase !== "Idle" && this.state.phase !== "GameOver") {
      return fail("本局已在进行中");
    }
    if (!this.config.armorOptions.includes(armor)) {
      return fail("未知初始装备");
    }
    this.reset();
    this.state.armor = armor;
    this.state.layer = 1;
    this.state.phase = "Prep";
    this.state.wallet = { pt: this.config.startPt, bag: [], purchaseLog: [] }; // 零开局物资
    this.log(`开局：${armor}，${this.config.startPt} PT，物资清空`);
    return ok();
  }

  /** Compatibility entry; all callers use the displayed shop price and purchase ledger. */
  cartRestore(): Result { return this.buy("cart_restore"); }

  private cartRestoreUnavailable(): string | null {
    if (this.state.cartRestoreUsed) return "猫车恢复整局仅限1次，已使用";
    if (this.state.cartsLeft >= this.config.maxCarts) return "当前猫车已满，无需恢复";
    return null;
  }

  /** 加权抽取：返回选中下标；weights 全 0 时返回 -1。确定性 RNG（可复现）。 */
  rollWeighted(weights: number[]): number {
    let total = 0;
    for (const w of weights) {
      if (!Number.isFinite(w) || w < 0) return -1;
      total += w;
    }
    if (total <= 0) return -1;
    let roll = (this.rng.nextUint() / 4294967296) * total;
    for (let i = 0; i < weights.length; i++) {
      roll -= weights[i]!;
      if (roll < 0) return i;
    }
    return weights.length - 1;
  }

  /** 重置为新一局（保留配置与 RNG 实例）。 */
  reset(): void {
    const fresh = createState(this.config.startPt, this.config.maxCarts);
    this.state.phase = fresh.phase;
    this.state.layer = fresh.layer;
    this.state.cartsLeft = fresh.cartsLeft;
    this.state.armor = fresh.armor;
    this.state.wallet = fresh.wallet;
    this.state.currentChoices = fresh.currentChoices;
    this.state.activeWave = fresh.activeWave;
    this.state.cartRestoreUsed = false;
    this.state.killedUltimates = [];
    this.state.log = [];
  }

  // ---------- 商店（分类检索 + 背包容量校验） ----------

  purchaseCheckpoint(): PurchaseCheckpoint {
    return { wallet: this.state.wallet, log: this.state.log.slice(), cartsLeft: this.state.cartsLeft,
      cartRestoreUsed: this.state.cartRestoreUsed };
  }

  rollbackPurchase(snapshot: PurchaseCheckpoint): void {
    this.state.wallet = snapshot.wallet; this.state.log = snapshot.log;
    this.state.cartsLeft = snapshot.cartsLeft; this.state.cartRestoreUsed = snapshot.cartRestoreUsed;
  }

  /** 按分类归组的商品列表，每项携带容量校验结果。 */
  getShop(): Record<string, ShopEntry[]> {
    const groups: Record<string, ShopEntry[]> = {};
    for (const item of this.config.shop) {
      const g = groups[item.category] ?? (groups[item.category] = []);
      g.push(this.toEntry(item));
    }
    for (const category of Object.keys(groups)) {
      groups[category]!.sort((a, b) => a.price - b.price);
    }
    return groups;
  }

  private purchaseCount(id: string): number {
    let n = 0;
    for (const p of this.state.wallet.purchaseLog) {
      if (p === id) n++;
    }
    return n;
  }

  private toEntry(item: ShopItem): ShopEntry {
    const owned = countOf(this.state.wallet, item.id);
    let canBuy = true;
    let reason: string | null = null;
    if (this.state.phase !== "Prep" && this.state.phase !== "Choosing") {
      canBuy = false;
      reason = "仅整备阶段可购买";
    } else if (item.id === "cart_restore" && this.cartRestoreUnavailable()) {
      canBuy = false;
      reason = this.cartRestoreUnavailable();
    } else if (item.mode !== "service" && owned >= item.cap) {
      canBuy = false;
      reason = "已达持有上限";
    } else if (item.globalLimit !== undefined && this.purchaseCount(item.id) >= item.globalLimit) {
      canBuy = false;
      reason = "全局限购已达";
    } else if (this.state.wallet.pt < item.price) {
      canBuy = false;
      reason = "PT不足";
    }
    return {
      id: item.id,
      name: item.name,
      category: item.category,
      price: item.price,
      cap: item.cap,
      owned,
      mode: item.mode,
      desc: item.desc ?? null,
      canBuy,
      reason,
    };
  }

  /**
   * 购买。perUnit：+1 件，超上限直接拒绝（绝不空耗 PT）。
   * fill：一次补满至上限（V1.3 弹药/素材模式），已满时拒绝。
   * service：不进背包、无容量语义，可重复购买。
   */
  buy(itemId: string): Result {
    if (this.state.phase !== "Prep" && this.state.phase !== "Choosing") {
      return fail("只有起始点整备期可以购买");
    }
    const item = this.config.shop.find((i) => i.id === itemId);
    if (!item) return fail("无此商品");
    if (itemId === "cart_restore") {
      const unavailable = this.cartRestoreUnavailable();
      if (unavailable) return fail(unavailable);
    }

    const owned = countOf(this.state.wallet, itemId);
    if (item.mode !== "service" && owned >= item.cap) {
      return fail(`${item.name} 已达持有上限（${item.cap}），不能再买`);
    }
    if (item.globalLimit !== undefined && this.purchaseCount(itemId) >= item.globalLimit) {
      return fail(`${item.name} 全局限购 ${item.globalLimit} 次已用完`);
    }
    if (this.state.wallet.pt < item.price) {
      return fail(`PT不足（需要 ${item.price}，持有 ${this.state.wallet.pt}）`);
    }

    const bag: OwnedItem[] =
      item.mode === "service"
        ? this.state.wallet.bag // 服务不进背包
        : replaceOrAdd(this.state.wallet.bag, itemId, owned + (item.mode === "fill" ? item.cap - owned : 1));
    this.state.wallet = {
      pt: this.state.wallet.pt - item.price,
      bag,
      purchaseLog: this.state.wallet.purchaseLog.concat([itemId]),
    };
    this.log(`购买 ${item.name}（-${item.price} PT）`);
    if (itemId === "cart_restore") {
      this.state.cartsLeft++;
      this.state.cartRestoreUsed = true;
      return ok(`猫车 ${this.state.cartsLeft}/${this.config.maxCarts}`);
    }
    if (item.mode === "service") return ok(`${item.name} 已生效`);
    const n = countOf(this.state.wallet, itemId);
    return ok(`${item.name} → ${n}/${item.cap}`);
  }

  // ---------- 任务选项生成（三选一，词条显式展开怪物组合） ----------

  /**
   * 生成 ChoiceCount 个候选任务，每个候选显式列出怪物组合
   * （如 "双弱：眠狗龙王 + 毒狗龙王"）。16+ 层只出极强怪单怪（AU）；
   * 解锁链未满足的极强怪不入池（Rise：爵银龙 → 冥渊龙）。
   */
  generateChoices(playerCount = 1): WaveOption[] {
    if (this.state.phase !== "Prep") return this.state.currentChoices;
    const tier = this.tierFor(this.state.layer);
    const types = this.allowedTypes(tier);
    if (types.length === 0) throw new Error("No available wave types");
    const dualTypes = types.filter((type) => type === "B" || type === "C" || type === "D");
    const singleType = types.find((type) => type === "A" || type === "AU");
    const opts: WaveOption[] = [];
    let previousDual: { type: string; composed: Tier } | null = null;
    for (let i = 0; i < this.config.choiceCount; i++) {
      // Ultimate-only pools retain their single-monster restriction.
      const requestedMode = dualTypes.length === 0 ? "single"
        : i % 3 === 0 ? "single" : i % 3 === 1 ? "sequential" : "simultaneous";
      const shared: { type: string; composed: Tier } | null = requestedMode === "simultaneous" ? previousDual : null;
      const type: string = shared ? shared.type : requestedMode === "single" ? (singleType ?? types[0]!)
        : dualTypes[this.rng.int(dualTypes.length)]!;
      const composed: Tier = shared ? { ...shared.composed, monsters: [...shared.composed.monsters] } : this.compose(type, tier);
      previousDual = requestedMode === "sequential" ? { type, composed } : null;
      const hp = this.hpMul(this.state.layer, type, playerCount);
      const dmg = this.dmgMul(this.state.layer, playerCount);
      // 双怪的血量折扣同步折扣基础分；任务倍率是"双怪烦"的唯一补偿（策划 V1.3 修订）
      const hpFactor = type === "B" || type === "C" || type === "D" ? this.config.scaling.dualCompensation : 1.0;
      let sum = 0;
      for (const m of composed.monsters) {
        sum += baseReward(this.config.reward, this.tierOfMonster(m, tier)) * hpFactor;
      }
      const baseRewardMul = this.config.typeRewardMul[type as RewardType];
      const mode = composed.monsters.length === 1 ? "single" : requestedMode === "single" ? "sequential" : requestedMode;
      const balance = this.config.simultaneousBalance ?? SIMULTANEOUS_BALANCE;
      const rewardMul = baseRewardMul * (mode === "simultaneous" ? balance.reward : 1);
      const pt = sum * rewardMul;
      const modeLabel = mode === "single" ? "Single" : mode === "sequential" ? "Sequential" : "Simultaneous";
      opts.push({
        mode,
        index: opts.length,
        typeTag: composed.tag,
        label: `${modeLabel} · ${composed.tag}：${composed.monsters.join(" + ")}`,
        monsters: composed.monsters,
        tier: composed.tier,
        rewardMul,
        hpMul: mode === "simultaneous" ? Math.round(hp * balance.hp * 10000) / 10000 : hp,
        dmgMul: mode === "simultaneous" ? Math.round(dmg * balance.damage * 10000) / 10000 : dmg,
        rewardPt: Math.trunc(pt),
      });
    }
    this.state.currentChoices = opts;
    this.state.phase = "Choosing";
    return opts;
  }

  private compose(type: string, tier: PoolTier): Tier {
    const ult = tier.tier === "ultimate";
    const pick = (arr: string[]): string => arr[this.rng.int(arr.length)]!;
    if (type === "A" || type === "AU") {
      return ult
        ? { tag: "极强怪单怪", monsters: [this.pickUltimate(tier)], tier: "ultimate" }
        : { tag: "单怪", monsters: [pick(this.strongOrWeak(tier))], tier: this.tierOfSingle(tier) };
    }
    if (type === "B") {
      return { tag: "双弱", monsters: [pick(tier.weak), pick(tier.weak)], tier: "weak" };
    }
    if (type === "C") {
      return { tag: "强弱混搭", monsters: [pick(tier.weak), pick(tier.strong!)], tier: "strong" };
    }
    if (type === "D") {
      return { tag: "双强", monsters: [pick(tier.strong!), pick(tier.strong!)], tier: "strong" };
    }
    throw new Error(`未知任务类型 ${type}`);
  }

  private availableUltimates(tier: PoolTier): string[] {
    const pool = tier.ultimate ?? [];
    return pool.filter((m) => {
      for (const rule of this.config.unlockChain) {
        if (rule.monster === m && !this.state.killedUltimates.includes(rule.requiresKilling)) {
          return false;
        }
      }
      return true;
    });
  }

  private pickUltimate(tier: PoolTier): string {
    const pool = this.availableUltimates(tier);
    if (pool.length === 0) throw new Error("ultimate 层没有可用怪物（解锁链未满足）");
    return pool[this.rng.int(pool.length)]!;
  }

  private strongOrWeak(t: PoolTier): string[] {
    return t.strong && t.strong.length > 0 ? t.strong : t.weak;
  }

  private tierOfSingle(t: PoolTier): string {
    switch (t.tier) {
      case "low":
        return "weak";
      case "mid":
        return "strong";
      case "adv":
        return "adv";
      default:
        return "ultimate";
    }
  }

  private tierFor(layer: number): PoolTier {
    const found = this.config.pools.find((p) => layer >= p.from && layer <= p.to);
    if (!found) throw new Error(`第 ${layer} 层没有对应的怪物池`);
    return found;
  }

  private allowedTypes(t: PoolTier): string[] {
    return t.tier === "ultimate" ? ["AU"] : t.types.slice();
  }

  private tierOfMonster(m: string, t: PoolTier): string {
    if (t.weak.includes(m)) return "weak";
    if (t.strong && t.strong.includes(m)) return "strong";
    if (t.tier === "ultimate" && t.ultimate && t.ultimate.includes(m)) return "ultimate";
    return "adv";
  }

  // ---------- 数值公式（唯一实现点，与所有前端共用） ----------

  hpMul(layer: number, type: string, players: number): number {
    const s = this.config.scaling;
    let base = Math.min(s.hpBase + (layer - 1) * s.hpPerLayer, s.hpCap);
    if (type === "B" || type === "C" || type === "D") base *= s.dualCompensation;
    if (type === "AU") base *= s.ultimateHpFactor;
    if (players === 2) base *= s.mp2Hp;
    else if (players >= 3) base *= s.mp34Hp;
    return Math.round(base * 1000) / 1000;
  }

  dmgMul(layer: number, players = 1): number {
    const s = this.config.scaling;
    const m = Math.min(s.dmgBase + (layer - 1) * s.dmgPerLayer, s.dmgCap);
    return players >= 3 ? m * s.mp34Dmg : m;
  }

  // ---------- 战斗流程 ----------

  pickChoice(index: number): Result {
    if (this.state.phase !== "Choosing") return fail("当前不在选任务阶段");
    const opt = this.state.currentChoices.find((o) => o.index === index);
    if (!opt) return fail("无效选项");
    this.state.activeWave = opt;
    this.state.phase = "Combat";
    this.log(`选择 ${opt.label}`);
    return ok(opt.label);
  }

  killWave(): Result {
    if (this.state.phase !== "Combat" || !this.state.activeWave) {
      return fail("当前没有进行中的战斗");
    }
    const w = this.state.activeWave;
    this.state.wallet = { ...this.state.wallet, pt: this.state.wallet.pt + w.rewardPt };
    if (w.tier === "ultimate") {
      for (const m of w.monsters) {
        if (!this.state.killedUltimates.includes(m)) this.state.killedUltimates.push(m);
      }
    }
    this.state.phase = "Carve";
    this.log(`讨伐完成 ${w.label}，+${w.rewardPt} PT（余额 ${this.state.wallet.pt}）`);
    return ok(`+${w.rewardPt} PT`);
  }

  cart(nativeQuestPlaying = false): Result {
    if (this.state.phase !== "Combat" && this.state.phase !== "Carve" &&
        !(nativeQuestPlaying && ["Choosing", "Prep"].includes(this.state.phase))) {
      return fail("不在战斗中");
    }
    this.state.cartsLeft--;
    this.log(`猫车！剩余 ${this.state.cartsLeft}`);
    if (this.state.cartsLeft <= 0) {
      this.state.phase = "GameOver";
      return fail("三次猫车，本局结束");
    }
    return ok(`剩余猫车 ${this.state.cartsLeft}`);
  }

  returnToCamp(): Result {
    if (this.state.phase !== "Carve") return fail("尚未完成讨伐");
    this.state.layer++;
    this.state.phase = "Prep";
    this.state.activeWave = null;
    this.state.currentChoices = [];
    this.log(`全员回到起始点，进入第 ${this.state.layer} 层整备`);
    return ok(`第 ${this.state.layer} 层`);
  }
}
