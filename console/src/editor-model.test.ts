import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { editorConfig, changes, preview } from "./editor-model";
import { Freshness, type ConsoleState } from "./api";
const raw = JSON.parse(readFileSync(new URL("../../data/rogue_config.json", import.meta.url), "utf8"));

it("normalizes imported PascalCase and Lua null arrays without changing the original", () => {
  const input = { ...raw, UnlockChain: null };
  const cfg = editorConfig(input); expect(cfg.unlockChain).toEqual([]);
  expect(cfg.simultaneousBalance!.reward).toBe(1.15); expect(input.UnlockChain).toBe(null);
});
it("previews the same paired monsters with editable simultaneous compensation", () => {
  const cfg = editorConfig(raw);
  cfg.simultaneousBalance = { hp: 0.8, damage: 0.9, reward: 1.3 };
  const opts = preview(cfg, 1, 1), seq = opts[1]!, sim = opts[2]!;
  expect(sim.monsters).toEqual(seq.monsters); expect(sim.hpMul).toBeCloseTo(seq.hpMul * 0.8, 4);
  expect(sim.dmgMul).toBeCloseTo(seq.dmgMul * 0.9, 4);
  expect(sim.rewardPt).toBeGreaterThan(seq.rewardPt);
  expect(changes(editorConfig(raw), cfg).some((d) => d.path === "simultaneousBalance.reward")).toBe(true);
});
it("detects a frozen game heartbeat despite successful HTTP polling", () => {
  const freshness = new Freshness();
  const state = { bridgeId: "a", counter: 1 } as ConsoleState;
  freshness.observe(state, 0); freshness.observe(state, 3000);
  expect(freshness.stale(4500)).toBe(true);
  freshness.observe({ ...state, counter: 2 }, 4600); expect(freshness.stale(4600)).toBe(false);
});
