import { describe, expect, it } from "vitest";
import type { RogueConfig, ShopItem } from "./config";
import { RunCore } from "./run_core";

/** 与 C# 测试同款的迷你配置：2 弱怪池 + 3 商品，刻意不配 unlockChain。 */
function cfg(): RogueConfig {
  const shop: ShopItem[] = [
    { id: "secret", name: "秘药", category: "药", price: 80, cap: 2, mode: "perUnit" },
    { id: "ammo_n1", name: "通常弹1", category: "弹", price: 8, cap: 60, mode: "fill" },
    { id: "gacha", name: "抽取", category: "服务", price: 50, cap: 0, mode: "service" },
  ];
  return {
    startPt: 150,
    maxCarts: 3,
    cartRestorePrice: 400,
    cartRestoreLimit: 1,
    choiceCount: 3,
    scaling: {
      hpBase: 0.75, hpPerLayer: 0.05, hpCap: 2.0,
      dmgBase: 1.0, dmgPerLayer: 0.03, dmgCap: 1.8,
      dualCompensation: 0.7, ultimateHpFactor: 1.1,
      mp2Hp: 1.4, mp34Hp: 1.8, mp34Dmg: 1.1,
    },
    reward: { weakBase: 80, strongBase: 120, advBase: 160, ultimateBase: 220 },
    typeRewardMul: { A: 1.0, B: 1.1, C: 1.3, D: 1.5, AU: 1.7 },
    armorOptions: ["骨套（均衡）", "铁套（攻高防低）"],
    pools: [
      {
        from: 1, to: 5, tier: "low",
        weak: ["土砂龙", "蛮颚龙"], strong: null, ultimate: null,
        types: ["A", "B"],
      },
      {
        from: 16, to: 999, tier: "ultimate",
        weak: ["土砂龙"], strong: null,
        ultimate: ["天彗龙", "爵银龙", "冥渊龙"],
        types: ["A"],
      },
    ],
    shop,
    quest: { id: 900101, baseId: 101, mapNo: 10 },
    unlockChain: [{ monster: "冥渊龙", requiresKilling: "爵银龙" }],
  };
}

function core(): RunCore {
  return new RunCore(cfg());
}

function started(): RunCore {
  const c = core();
  expect(c.startRun("骨套（均衡）").ok).toBe(true);
  return c;
}

describe("review regressions", () => {
  it("starts a clean run after game over, including carts, unlocks and limits", () => {
    const c = started();
    c.generateChoices();
    c.pickChoice(0);
    c.cart();
    c.killWave();
    c.returnToCamp();
    c.state.wallet.pt = 1000;
    expect(c.cartRestore().ok).toBe(true);
    c.state.killedUltimates.push("previous run boss");
    c.buy("secret");
    c.generateChoices();
    c.pickChoice(0);
    c.cart(); c.cart(); c.cart();
    expect(c.state.phase).toBe("GameOver");
    const stateReference = c.state;
    expect(c.startRun(c.config.armorOptions[0]!).ok).toBe(true);
    expect(c.state).toBe(stateReference);
    expect(c.state).toMatchObject({
      phase: "Prep", layer: 1, cartsLeft: 3, activeWave: null,
      currentChoices: [], killedUltimates: [], cartRestoreUsed: false,
      wallet: { pt: 150, bag: [], purchaseLog: [] },
    });
    expect(c.state.log).toHaveLength(1);
    c.generateChoices(); c.pickChoice(0);
    c.cart(); c.killWave(); c.returnToCamp();
    c.state.wallet.pt = 1000;
    expect(c.cartRestore().ok).toBe(true);
  });

  it("uses AU multipliers in actual ultimate choices and pays the reward", () => {
    const c = started();
    c.state.layer = 16;
    const choices = c.generateChoices();
    expect(choices).toHaveLength(c.config.choiceCount);
    expect(choices[0]).toMatchObject({ tier: "ultimate", hpMul: 1.65, rewardMul: 1.7, rewardPt: 374 });
    c.pickChoice(0); c.killWave();
    expect(c.state.wallet.pt).toBe(524);
  });

  it.each([1, 2, 3, 4])("applies damage scaling to generated %i-player options", (players) => {
    const c = started();
    const options = c.generateChoices(players);
    expect(options.length).toBeGreaterThan(0);
    for (const option of options) expect(option.dmgMul).toBe(players >= 3 ? 1.1 : 1);
  });
});

describe("RunCore（C# MhwRogue.Tests 语义移植）", () => {
  it("开局：清物资、发 150PT、进入 Prep", () => {
    const c = started();
    expect(c.state.phase).toBe("Prep");
    expect(c.state.wallet.pt).toBe(150);
    expect(c.state.wallet.bag).toHaveLength(0);
  });

  it("未开局时商店购买被拒绝", () => {
    expect(core().buy("secret").ok).toBe(false);
  });

  it("开局后非开局装备被拒绝", () => {
    expect(core().startRun(" sequentially 无效装备").ok).toBe(false);
  });

  it("秘药 PT 不足时拒绝且不空耗", () => {
    const c = started();
    expect(c.buy("secret").ok).toBe(true); // 150-80=70
    const r2 = c.buy("secret"); // 需要 80，只有 70
    expect(r2.ok).toBe(false);
    expect(r2.message).toContain("Not enough PT");
  });

  it("fill 模式一次补满，再买被上限拦截", () => {
    const c = started();
    expect(c.buy("ammo_n1").ok).toBe(true);
    expect(c.state.wallet.bag[0]).toMatchObject({ id: "ammo_n1", count: 60 });
    const again = c.buy("ammo_n1");
    expect(again.ok).toBe(false);
    expect(again.message).toContain("carry limit");
  });

  it("service 不进背包且可重复购买", () => {
    const c = started();
    for (let i = 0; i < 2; i++) {
      expect(c.buy("gacha").ok).toBe(true);
      expect(c.state.wallet.bag).toHaveLength(0);
    }
  });

  it("双怪奖励含血量折扣：单怪 80，双弱 (80*0.7*2)*1.1=123", () => {
    // 穷举多个种子直到两种组合都出现过（2 弱怪池、A/B 两类型，概率高）
    for (let seed = 1; seed < 200; seed++) {
      const c = new RunCore(cfg(), seed);
      c.startRun("骨套（均衡）");
      for (const o of c.generateChoices()) {
        if (o.monsters.length === 2) expect(o.rewardPt).toBe(123);
        else expect(o.rewardPt).toBe(80);
      }
    }
  });

  it("同种子抽卡结果完全一致（联机确定性前提）", () => {
    const a = new RunCore(cfg(), 42);
    a.startRun("骨套（均衡）");
    const b = new RunCore(cfg(), 42);
    b.startRun("骨套（均衡）");
    const oa = a.generateChoices();
    const ob = b.generateChoices();
    expect(oa.length).toBe(ob.length);
    oa.forEach((opt, i) => {
      expect(opt.label).toBe(ob[i]!.label);
      expect(opt.hpMul).toBe(ob[i]!.hpMul);
      expect(opt.rewardPt).toBe(ob[i]!.rewardPt);
    });
  });

  it("血量公式：层数封顶 / 双怪补偿 / 多人倍率", () => {
    const c = core();
    expect(c.hpMul(1, "A", 1)).toBe(0.75);
    expect(c.hpMul(40, "A", 1)).toBe(2.0); // 封顶
    expect(c.hpMul(1, "B", 1)).toBe(0.525); // 0.75*0.7
    expect(c.hpMul(1, "A", 2)).toBe(1.05); // *1.4
    expect(c.hpMul(1, "A", 4)).toBe(1.35); // *1.8
  });

  it("完整循环：讨伐 → 回营地 → 层数+1", () => {
    const c = started();
    c.generateChoices();
    expect(c.pickChoice(0).ok).toBe(true);
    expect(c.killWave().ok).toBe(true);
    const ret = c.returnToCamp();
    expect(ret.ok).toBe(true);
    expect(c.state.layer).toBe(2);
    expect(c.state.phase).toBe("Prep");
  });

  it("三猫失败进入 GameOver", () => {
    const c = started();
    c.generateChoices();
    c.pickChoice(0);
    expect(c.cart().ok).toBe(true);
    expect(c.cart().ok).toBe(true);
    const last = c.cart();
    expect(last.ok).toBe(false);
    expect(c.state.phase).toBe("GameOver");
  });
});

describe("Rise 新增语义", () => {
  it("解锁链：未讨伐爵银龙时冥渊龙不入池，讨伐后入池", () => {
    function ultimateLabels(killedFirst: boolean): string[] {
      const labels: string[] = [];
      for (let seed = 0; seed < 300; seed++) {
        const cc = new RunCore(cfg(), seed);
        cc.startRun("骨套（均衡）");
        if (killedFirst) cc.state.killedUltimates.push("爵银龙");
        cc.state.layer = 16; // ultimate 层
        cc.state.phase = "Prep";
        for (const o of cc.generateChoices()) labels.push(o.label);
      }
      return labels;
    }
    expect(ultimateLabels(false).some((l) => l.includes("冥渊龙"))).toBe(false);
    expect(ultimateLabels(true).some((l) => l.includes("冥渊龙"))).toBe(true);
  });

  it("极强怪单怪获得 AU 奖励倍率与血量系数", () => {
    const c = started();
    expect(c.hpMul(1, "AU", 1)).toBeCloseTo(0.75 * 1.1, 6);
  });

  it("猫车恢复：限购一次、满员拒绝、可救回猫车", () => {
    const c = started();
    expect(c.cartRestore().ok).toBe(false); // 满员
    c.generateChoices();
    c.pickChoice(0);
    c.killWave();
    c.cart();
    c.returnToCamp();
    expect(c.cartRestore().message).toContain("Not enough PT"); // 400PT > 150
    c.state.wallet.pt = 1000;
    expect(c.cartRestore().ok).toBe(true);
    expect(c.state.cartsLeft).toBe(3);
    expect(c.cartRestore().ok).toBe(false); // 整局一次已用
  });
});
