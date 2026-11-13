import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateConfig, type RogueConfig, type ShopItem } from "./config";
import { RunCore } from "./run_core";

/** 与 C# 测试同款的迷你配置：2 弱怪池 + 4 商品，刻意不配 unlockChain。 */
function cfg(): RogueConfig {
  const shop: ShopItem[] = [
    { id: "secret", name: "秘药", category: "药", price: 80, cap: 2, mode: "perUnit" },
    { id: "ammo_n1", name: "通常弹1", category: "弹", price: 8, cap: 60, mode: "fill" },
    { id: "cart_restore", name: "猫车恢复", category: "服务", price: 400, cap: 0, mode: "service", globalLimit: 1 },
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
        ultimate: ["天彗龙", "爵银龙", "激昂金狮子", "嗟怨怨虎龙", "冥渊龙"],
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
    for (const option of options) expect(option.dmgMul).toBeCloseTo((players >= 3 ? 1.1 : 1) * (option.mode === "simultaneous" ? 0.95 : 1));
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
    expect(r2.message).toContain("PT不足");
  });

  it("fill 模式一次补满，再买被上限拦截", () => {
    const c = started();
    expect(c.buy("ammo_n1").ok).toBe(true);
    expect(c.state.wallet.bag[0]).toMatchObject({ id: "ammo_n1", count: 60 });
    const again = c.buy("ammo_n1");
    expect(again.ok).toBe(false);
    expect(again.message).toContain("持有上限");
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
        if (o.monsters.length === 2) expect(o.rewardPt).toBe(o.mode === "simultaneous" ? 141 : 123);
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
    expect(c.cartRestore().message).toContain("PT不足"); // 400PT > 150
    c.state.wallet.pt = 1000;
    expect(c.cartRestore().ok).toBe(true);
    expect(c.state.cartsLeft).toBe(3);
    expect(c.cartRestore().ok).toBe(false); // 整局一次已用
  });

  it("shop cart restoration changes shared carts and the one-use flag, charging the displayed price once", () => {
    const c = started();
    c.config.shop.find(item => item.id === "cart_restore")!.price = 350;
    c.state.wallet.pt = 1000;
    expect(c.buy("cart_restore").ok).toBe(false);
    expect(c.state.wallet.pt).toBe(1000);
    c.state.cartsLeft = 2;
    expect(c.buy("cart_restore").ok).toBe(true);
    expect(c.state).toMatchObject({ cartsLeft: 3, cartRestoreUsed: true,
      wallet: { pt: 650, purchaseLog: ["cart_restore"] } });
    c.state.cartsLeft = 2;
    expect(c.buy("cart_restore").ok).toBe(false);
    expect(c.getShop()["服务"]!.find(e => e.id === "cart_restore")!.canBuy).toBe(false);
    expect(c.state.wallet.pt).toBe(650);
  });
});

it("offers Single, Sequential and Simultaneous as distinct normal-tier choices", () => {
 const c = started(); const choices = c.generateChoices();
 expect(choices.map((o) => o.mode)).toEqual(["single", "sequential", "simultaneous"]);
 expect(choices.map((o) => o.monsters.length)).toEqual([1, 2, 2]);
 c.state.layer = 16; c.state.phase = "Prep";
 expect(c.generateChoices().every((o) => o.mode === "single" && o.monsters.length === 1)).toBe(true);
});

it.each([1, 2, 3, 4])("offers more PT and slightly easier stats for the same simultaneous pair (%i players)", (players) => {
 const c = started(); const [, seq, sim] = c.generateChoices(players);
 expect(seq!.mode).toBe("sequential"); expect(sim!.mode).toBe("simultaneous");
 expect(sim!.monsters).toEqual(seq!.monsters);
 expect(sim!.monsters).not.toBe(seq!.monsters);
 expect(sim!.rewardMul).toBeCloseTo(seq!.rewardMul * 1.15);
 expect(sim!.rewardPt).toBeGreaterThan(seq!.rewardPt);
 expect(sim!.hpMul).toBeCloseTo(seq!.hpMul * 0.9, 4);
 expect(sim!.dmgMul).toBeCloseTo(seq!.dmgMul * 0.95, 4);
 c.pickChoice(sim!.index); c.killWave();
 expect(c.state.wallet.pt).toBe(150 + sim!.rewardPt);
});

describe("M3.5 ultimate pool (Rise 终盘重排)", () => {
  const ULTIMATE_CFG = (): RogueConfig => {
    const raw = JSON.parse(readFileSync(new URL("../../data/rogue_config.json", import.meta.url), "utf8")) as unknown;
    return validateConfig(raw);
  };

  it("data/rogue_config.json Ultimate 含激昂金狮子/嗟怨怨虎龙/冥渊龙且校验通过", () => {
    const config = ULTIMATE_CFG();
    const ultimate = config.pools.find((p) => p.tier === "ultimate")!.ultimate ?? [];
    for (const name of ["激昂金狮子", "嗟怨怨虎龙", "冥渊龙"]) {
      expect(ultimate).toContain(name);
    }
    // 名字↔ID 对应（策划案需要的 1303/1369/135 三个 id）
    const catalog = JSON.parse(readFileSync(new URL("../../data/monster_ids.json", import.meta.url), "utf8")) as
      Record<string, { id: number; cn?: string }>;
    expect(catalog["Furious Rajang"]).toMatchObject({ id: 1303, cn: "激昂金狮子" });
    expect(catalog["Scorned Magnamalo"]).toMatchObject({ id: 1369, cn: "嗟怨怨虎龙" });
    expect(catalog["Gaismagorm"]).toMatchObject({ id: 135, cn: "冥渊龙" });
  });

  it("layer16 AU 波可抽到激昂金狮子/嗟怨怨虎龙/冥渊龙（确定性种子覆盖）", () => {
    const c = new RunCore(cfg(), 7);
    expect(c.startRun("骨套（均衡）").ok).toBe(true);
    c.state.layer = 16;
    const seen = new Set<string>();
    for (let i = 0; i < 400; i++) {
      c.state.phase = "Prep"; // generateChoices 在非 Prep 时返回缓存选项，须显式重采样
      for (const choice of c.generateChoices()) {
        expect(choice.tier).toBe("ultimate");
        for (const m of choice.monsters) {
          // 未讨伐爵银龙：冥渊龙必须被 unlockChain 过滤
          expect(m).not.toBe("冥渊龙");
          seen.add(m);
        }
      }
    }
    for (const name of ["激昂金狮子", "嗟怨怨虎龙", "天彗龙", "爵银龙"]) {
      expect(seen.has(name)).toBe(true);
    }
  });

  it("讨伐爵银龙后冥渊龙可选且 id=135", () => {
    const c = new RunCore(cfg(), 7);
    expect(c.startRun("骨套（均衡）").ok).toBe(true);
    c.state.layer = 16;
    c.state.killedUltimates.push("爵银龙");
    const seen = new Set<string>();
    for (let i = 0; i < 400; i++) {
      c.state.phase = "Prep";
      for (const choice of c.generateChoices()) {
        for (const m of choice.monsters) seen.add(m);
      }
    }
    expect(seen.has("冥渊龙")).toBe(true);
    // 每个可选怪都在目录里且 id 为正（quest_plan 按中文名反查的前提）
    const catalog = JSON.parse(readFileSync(new URL("../../data/monster_ids.json", import.meta.url), "utf8")) as
      Record<string, { id: number; cn?: string }>;
    const byCn = new Map(Object.entries(catalog).map(([en, v]) => [v.cn ?? en, v]));
    for (const name of seen) {
      expect(byCn.get(name)).toBeDefined();
      expect(byCn.get(name)!.id).toBeGreaterThan(0);
    }
  });
});

it("legacy cartRestore entry uses the shop price and records the shared limit", () => {
  const c = started(); c.state.cartsLeft = 2; c.state.wallet.pt = 500;
  c.config.shop.find(item => item.id === "cart_restore")!.price = 300;
  expect(c.cartRestore().ok).toBe(true);
  expect(c.state.wallet.pt).toBe(200);
  expect(c.state.wallet.purchaseLog).toEqual(["cart_restore"]);
  c.state.cartsLeft = 2; expect(c.buy("cart_restore").ok).toBe(false);
});

it("enforces shop layer windows in listing and purchase",()=>{
 const config=cfg();config.shop[0]!.unlockLayer=3;config.shop[0]!.endLayer=5;
 const core=new RunCore(config);core.state.phase="Prep";core.state.wallet.pt=1000;
 for(const layer of [2,6]){core.state.layer=layer;expect(Object.values(core.getShop()).flat().some(x=>x.id==="secret")).toBe(false);expect(core.buy("secret").ok).toBe(false);}
 core.state.layer=3;expect(Object.values(core.getShop()).flat().some(x=>x.id==="secret")).toBe(true);expect(core.buy("secret").ok).toBe(true);
});
