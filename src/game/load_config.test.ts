import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "./load_config";
import { rejson, relog } from "./sdk";
import { defaultConfig } from "./default_config";

vi.mock("./sdk", () => ({
  rejson: { load_file: vi.fn() },
  relog: { info: vi.fn(), warn: vi.fn() },
}));

describe("runtime configuration overrides", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(["negative price", "missing unlock rules"])("falls back on %s", (problem) => {
    const override = JSON.parse(JSON.stringify(defaultConfig));
    if (problem === "negative price") override.Shop[0].Price = -100;
    else delete override.UnlockChain;
    vi.mocked(rejson.load_file).mockReturnValue(override);
    const config = loadConfig();
    expect(config.shop[0]!.price).toBeGreaterThanOrEqual(0);
    expect(config.unlockChain.length).toBeGreaterThan(0);
    expect(relog.warn).toHaveBeenCalledOnce();
    expect(relog.info).not.toHaveBeenCalled();
  });

  it("accepts a valid override", () => {
    const override = { ...defaultConfig, StartPt: 999 };
    vi.mocked(rejson.load_file).mockReturnValue(override);
    expect(loadConfig().startPt).toBe(999);
    expect(relog.info).toHaveBeenCalledOnce();
    expect(relog.warn).not.toHaveBeenCalled();
  });
});
