import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateConfig } from "./config";
import { RunCore } from "./run_core";

describe("shipped configuration", () => {
  it("loads the actual PascalCase JSON and runs a choice through the core", () => {
    const raw = JSON.parse(readFileSync(new URL("../../data/rogue_config.json", import.meta.url), "utf8"));
    const config = validateConfig(raw);
    expect(config.quest).toEqual({ id: 900101, baseId: 101, mapNo: 10 });
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
