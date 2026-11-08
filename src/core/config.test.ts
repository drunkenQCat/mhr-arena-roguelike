import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateConfig } from "./config";
import { RunCore } from "./run_core";

function config(): Record<string, any> {
  return JSON.parse(readFileSync(new URL("../../data/rogue_config.json", import.meta.url), "utf8"));
}

describe("configuration boundary", () => {
  it.each([
    ["missing unlock rules", (c: any) => { delete c.UnlockChain; }],
    ["negative price", (c: any) => { c.Shop[0].Price = -100; }],
    ["missing scaling field", (c: any) => { delete c.Scaling.Mp34Dmg; }],
    ["missing reward multiplier", (c: any) => { delete c.TypeRewardMul.AU; }],
    ["missing base quest", (c: any) => { delete c.Quest.BaseId; }],
    ["non-finite number", (c: any) => { c.StartPt = Infinity; }],
    ["fractional carts", (c: any) => { c.MaxCarts = 2.5; }],
    ["zero choices", (c: any) => { c.ChoiceCount = 0; }],
    ["invalid shop mode", (c: any) => { c.Shop[0].Mode = "oops"; }],
    ["duplicate shop ID", (c: any) => { c.Shop[1].Id = c.Shop[0].Id; }],
    ["invalid pool type", (c: any) => { c.Pools[0].Types = ["Z"]; }],
    ["empty ultimate pool", (c: any) => { c.Pools[3].Ultimate = []; }],
    ["dual strong without strong pool", (c: any) => { c.Pools[0].Types = ["D"]; }],
    ["pool gap", (c: any) => { c.Pools[1].From = 7; }],
    ["invalid rule", (c: any) => { c.UnlockChain[0].RequiresKilling = null; }],
    ["armor ID with missing body part", (c: any) => { c.GachaPools.gacha_1.Entries[0].Id = 0x0c000009; }],
    ["armor ID with invalid body part", (c: any) => { c.GachaPools.gacha_1.Entries[0].Id = 0x0c600009; }],
  ])("rejects %s before runtime", (_name, mutate) => {
    const c = config();
    mutate(c);
    expect(() => validateConfig(c)).toThrow();
  });

  it.each([null, undefined, [], 1, "invalid"])('rejects invalid root %j', (raw) => {
    expect(() => validateConfig(raw)).toThrow();
  });

  it("accepts an empty unlock chain and free service items", () => {
    const c = config();
    c.UnlockChain = [];
    const service = c.Shop.find((item: any) => item.Mode === "service");
    service.Price = 0;
    expect(validateConfig(c).unlockChain).toEqual([]);
  });
});

describe("shipped configuration", () => {
  it("loads the actual PascalCase JSON and runs a choice through the core", () => {
    const raw = JSON.parse(readFileSync(new URL("../../data/rogue_config.json", import.meta.url), "utf8"));
    const config = validateConfig(raw);
    expect(config.quest).toEqual({ id: 900102, baseId: 603, mapNo: 10 });
    expect(config.typeRewardMul.AU).toBe(1.7);
    expect(config.unlockChain[0]?.requiresKilling).toBeTruthy();
    const core = new RunCore(config);
    expect(core.startRun(config.armorOptions[0]!).ok).toBe(true);
    expect(core.generateChoices().length).toBeGreaterThan(0);
    expect(core.pickChoice(0).ok).toBe(true);
  });

  it("also accepts the normalized TypeScript shape", () => {
    const raw = JSON.parse(readFileSync(new URL("../../data/rogue_config.json", import.meta.url), "utf8"));
    const config = validateConfig(raw);
    expect(validateConfig(config)).toEqual(config);
  });
});
