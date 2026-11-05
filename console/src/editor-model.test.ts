import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { editorConfig, changes, preview, sampleBalance } from "./editor-model";
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
it('rejects invalid preview controls instead of silently previewing an unrelated layer', () => {
  for (const layer of [0, -1, 1.5, NaN, Infinity, 100000])
    expect(() => preview(raw, layer, 1)).toThrow('层数');
  for (const players of [0, 1.5, 5, NaN])
    expect(() => preview(raw, 1, players)).toThrow('人数');
});
it('samples reproducibly without mutating the draft and reflects reward changes', () => {
  const cfg = editorConfig(raw), original = JSON.stringify(cfg);
  const sampled = sampleBalance(cfg, 1, 2);
  expect(sampleBalance(cfg, 1, 2)).toEqual(sampled);
  expect(JSON.stringify(cfg)).toBe(original);
  expect(sampled.map(row => row.mode)).toEqual(['single', 'sequential', 'simultaneous']);
  for (const row of sampled) {
    expect(row.count).toBe(24);
    expect(row.meanPt).toBeGreaterThanOrEqual(row.minPt);
    expect(row.meanPt).toBeLessThanOrEqual(row.maxPt);
  }
  cfg.simultaneousBalance!.reward *= 2;
  const changed = sampleBalance(cfg, 1, 2);
  expect(changed[0]).toEqual(sampled[0]);
  expect(changed[2]!.meanPt).toBeGreaterThan(sampled[2]!.meanPt);
});
