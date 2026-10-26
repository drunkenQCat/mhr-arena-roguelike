import { beforeEach, describe, expect, it, vi } from "vitest";
import { RunCore } from "../core/run_core";
import { validateConfig } from "../core/config";
import { defaultConfig } from "./default_config";
const mock = vi.hoisted(() => ({ click: false, selecting: true, village: true, count: 2,
  grant: vi.fn(), dumps: vi.fn() }));
vi.mock("./item_grant", () => ({ canTradeInVillage: () => mock.village,
  pouchCount: () => mock.count, grantItem: mock.grant }));
vi.mock("./sdk", () => ({ rejson: { dump_file: mock.dumps }, imguiApi: {
  tree_node: () => true, tree_pop: () => {}, separator: () => {}, same_line: () => {},
  text: () => {}, text_disabled: () => {},
  button: (label: string) => { if (label.includes("PT") && mock.click) { mock.click = false; return true; } return false; },
} }));
import { ShopWindow } from "./shop_window";

function fixture() {
  const config = validateConfig(defaultConfig);
  config.shop = [{ id: "potion", name: "Potion", category: "Items", price: 10, cap: 10, mode: "perUnit", globalLimit: 1 }];
  const core = new RunCore(config, 42);
  core.startRun(config.armorOptions[0]!); core.generateChoices();
  const shop = new ShopWindow(core, () => mock.selecting);
  return { core, shop, click: () => { mock.click = true; shop.draw(); } };
}
beforeEach(() => {
  mock.click = false; mock.selecting = true; mock.village = true; mock.count = 2;
  mock.grant.mockReset(); mock.dumps.mockReset();
});
describe("shop transaction", () => {
  it("queues on draw, reads actual pouch and commits PT/limit only for verified delivery", () => {
    const { core, shop, click } = fixture(); const initial = core.state.wallet.pt;
    mock.grant.mockReturnValue({ granted: true, before: 2, after: 3, gameName: "Potion" });
    click(); expect(mock.grant).not.toHaveBeenCalled(); expect(shop.busy).toBe(true);
    shop.tick(); expect(core.state.wallet.pt).toBe(initial - 10);
    expect(core.state.wallet.bag[0]?.count).toBe(3);
    click(); shop.tick(); expect(mock.grant).toHaveBeenCalledTimes(1);
  });
  it("restores both PT and global limit when delivery is confirmed absent", () => {
    const { core, shop, click } = fixture(); const initial = core.state.wallet.pt;
    mock.grant.mockReturnValue({ granted: false });
    click(); shop.tick(); expect(core.state.wallet.pt).toBe(initial);
    expect(core.state.wallet.purchaseLog).toEqual([]);
    expect(core.state.log.some((line) => line.includes("购买"))).toBe(false);
  });
  it("blocks retries and wave selection on an uncertain native mutation", () => {
    const { core, shop, click } = fixture(); const initial = core.state.wallet.pt;
    mock.grant.mockReturnValue({ granted: false, uncertain: true });
    click(); shop.tick(); click(); shop.tick();
    expect(shop.busy).toBe(true); expect(core.state.wallet.pt).toBe(initial - 10);
    expect(mock.grant).toHaveBeenCalledTimes(1);
  });
  it("revalidates the stage after a queued click", () => {
    const { shop, click } = fixture(); click(); mock.selecting = false; shop.tick();
    expect(mock.grant).not.toHaveBeenCalled();
  });
  it("locks an unexpectedly throwing delivery instead of permitting a duplicate retry", () => {
    const { shop, click } = fixture(); mock.grant.mockImplementation(() => { throw new Error("unknown native state"); });
    click(); shop.tick(); click(); shop.tick();
    expect(shop.busy).toBe(true); expect(mock.grant).toHaveBeenCalledTimes(1);
  });
});
