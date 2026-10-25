import { describe, expect, it } from "vitest";
import { Rng } from "./rng";

describe("RNG seed normalization", () => {
  it("normalizes zero explicitly to the fallback seed", () => {
    const zero = new Rng(0);
    const fallback = new Rng(0x9e3779b9);
    for (let i = 0; i < 100; i++) expect(zero.nextUint()).toBe(fallback.nextUint());
  });

  it("replays nonzero seeds and keeps draws in range", () => {
    const a = new Rng(42);
    const b = new Rng(42);
    for (let i = 0; i < 100; i++) {
      const draw = a.int(7);
      expect(draw).toBe(b.int(7));
      expect(draw).toBeGreaterThanOrEqual(0);
      expect(draw).toBeLessThan(7);
    }
  });
});
