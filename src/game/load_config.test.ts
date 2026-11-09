import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "./load_config";
import { rejson, relog,refFs } from "./sdk";
import { defaultConfig } from "./default_config";

vi.mock("./sdk", () => ({
  refFs:{read:vi.fn(()=>""),glob:vi.fn(()=>[])},
  rejson: { load_file: vi.fn() },
  relog: { info: vi.fn(), warn: vi.fn() },
}));

describe("runtime configuration overrides", () => {
  beforeEach(() => {vi.clearAllMocks();vi.mocked(refFs.read).mockReturnValue("");vi.mocked(refFs.glob).mockReturnValue([]);});

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
  it("does not silently load defaults over a corrupt pending multiplayer config",()=>{
    vi.mocked(refFs.read).mockReturnValue("{");vi.mocked(refFs.glob).mockReturnValue(["mhw_rogue_config_pending.json"]);
    expect(()=>loadConfig()).toThrow("配置恢复记录损坏");expect(rejson.load_file).not.toHaveBeenCalled();
  });
});
