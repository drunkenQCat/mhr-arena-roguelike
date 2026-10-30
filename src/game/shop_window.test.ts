import { beforeEach, describe, expect, it, vi } from "vitest";
import { RunCore } from "../core/run_core";
import { validateConfig } from "../core/config";
import { defaultConfig } from "./default_config";
const mock = vi.hoisted(() => ({ click: false, selecting: true, village: true, count: 2,
  grant: vi.fn(), dumps: vi.fn(), begin: vi.fn(), end: vi.fn(), text: vi.fn() }));
vi.mock("./item_grant", () => ({ canTrade: () => mock.village,
  pouchCount: () => mock.count, grantItem: mock.grant }));
vi.mock("./sdk", () => ({ clockSeconds: () => 0, rejson: { dump_file: mock.dumps }, imguiApi: {
  begin_window: mock.begin, end_window: mock.end,
  set_next_window_pos: () => {}, set_next_window_size: () => {},
  separator: () => {}, same_line: () => {}, text: mock.text,
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
  mock.begin.mockReset().mockReturnValue(true); mock.end.mockReset(); mock.text.mockReset();
});
describe("shop transaction", () => {
  it("opens independently, stays closed after X, and can be reopened or auto-opened next prep", () => {
    const { shop } = fixture();
    mock.begin.mockReturnValueOnce(false); shop.draw();
    expect(mock.end).toHaveBeenCalledTimes(1);
    shop.draw(); expect(mock.begin).toHaveBeenCalledTimes(1);
    shop.open(); shop.draw(); expect(mock.begin).toHaveBeenCalledTimes(2);
    mock.selecting = false; shop.draw(); expect(mock.begin).toHaveBeenCalledTimes(2);
    mock.selecting = true; shop.draw(); expect(mock.begin).toHaveBeenCalledTimes(3);
    expect(mock.end).toHaveBeenCalledTimes(3);
  });
  it("balances the native window stack even if content rendering throws", () => {
    const { shop } = fixture(); mock.text.mockImplementationOnce(() => { throw new Error("draw failed"); });
    expect(() => shop.draw()).toThrow("draw failed");
    expect(mock.end).toHaveBeenCalledTimes(1);
  });
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
  it("locks an unexpected delivery exception after debit because the native result is unknown", () => {
    const { shop, click } = fixture(); mock.grant.mockImplementation(() => { throw new Error("unknown native state"); });
    click(); shop.tick(); click(); shop.tick();
    expect(shop.busy).toBe(true); expect(mock.grant).toHaveBeenCalledTimes(1);
    expect(shop.lastTransaction?.status).toBe("uncertain");
  });
  it("locks unresolved when grant reports uncertain delivery", () => {
    const { shop, click } = fixture(); mock.grant.mockReturnValue({ granted: false, uncertain: true, before: 2 });
    click(); shop.tick();
    expect(shop.busy).toBe(true);
  });
});

it("passes the between-wave quest identity to delivery and logs blocked queued purchases", () => {
  const { core } = fixture();
  const context = { questId: 900102, questUnique: 42 };
  const shop = new ShopWindow(core, () => mock.selecting, () => context);
  mock.grant.mockReturnValue({ granted: true, before: 2, after: 3 });
  mock.click = true; shop.draw(); shop.tick();
  expect(mock.grant).toHaveBeenCalledWith("potion", 1, context);
  mock.selecting = false;
  // A queued request must be revalidated even when the game state changes before tick.
  mock.selecting = true; core.state.wallet.purchaseLog = [];
  mock.click = true; shop.draw(); mock.village = false; shop.tick();
  expect(mock.dumps).toHaveBeenLastCalledWith("mhw_rogue_shop_transaction.json", expect.objectContaining({ blocked: true }), 2);
  expect(mock.grant).toHaveBeenCalledTimes(1);
});

describe("M3.6 service delivery", () => {
  function serviceFixture() {
    const config = validateConfig(defaultConfig);
    config.shop = [
      { id: "buff_atk", name: "单轮攻击UP", category: "翻盘服务", price: 80, cap: 0, mode: "service" },
      { id: "gacha_1", name: "初级抽取", category: "翻盘服务", price: 120, cap: 0, mode: "service" },
      { id: "gacha_9", name: "未配置池", category: "翻盘服务", price: 120, cap: 0, mode: "service" },
      { id: "cart_restore", name: "猫车恢复", category: "翻盘服务", price: 400, cap: 0, mode: "service", globalLimit: 1 },
    ];
    const core = new RunCore(config, 42);
    core.startRun(config.armorOptions[0]!); core.generateChoices();
    const buffBuy = vi.fn(() => ({ ok: true, total: 10 }));
    const gachaBuy = vi.fn(() => ({ ok: true, name: "合金头盔", kind: "armor" as const, id: 1, boxIndex: 3, reused: false }));
    const shop = new ShopWindow(core, () => mock.selecting, () => undefined,
      { buffBuy, gachaBuy, hasGachaPool: (id) => id === "gacha_1" });
    return { core, shop, buffBuy, gachaBuy };
  }

  it("闸门：有服务的 buff/gacha 开放，无池 gacha 不开放", () => {
    const { shop } = serviceFixture();
    const cats = shop.catalogue(true).categories;
    const all = Object.values(cats).flat();
    const byId = Object.fromEntries(all.map((e) => [e.id, e]));
    expect(byId["buff_atk"]!.canBuy).toBe(true);
    expect(byId["gacha_1"]!.canBuy).toBe(true);
    expect(byId["gacha_9"]!.canBuy).toBe(false);
  });

  it("buff 购买走效果交付并成功结算", () => {
    const { shop, buffBuy, core } = serviceFixture();
    expect(shop.requestPurchase("buff_atk").ok).toBe(true);
    shop.tick();
    expect(buffBuy).toHaveBeenCalledWith("buff_atk");
    expect(shop.lastTransaction?.status).toBe("applied");
    expect(core.state.wallet.pt).toBe(core.config.startPt - 80);
  });

  it("gacha 购买成功播报名字", () => {
    const { shop, gachaBuy } = serviceFixture();
    expect(shop.requestPurchase("gacha_1").ok).toBe(true);
    shop.tick();
    expect(gachaBuy).toHaveBeenCalledWith("gacha_1");
    expect(shop.lastTransaction?.status).toBe("applied");
    expect(shop.lastTransaction?.message).toContain("合金头盔");
  });

  it("gacha 不确定结果进入 unresolved，不回滚 PT", () => {
    const { shop, gachaBuy, core } = serviceFixture();
    gachaBuy.mockReturnValueOnce({ ok: false, uncertain: true, reason: "槽位被触碰" });
    expect(shop.requestPurchase("gacha_1").ok).toBe(true);
    shop.tick();
    expect(shop.lastTransaction?.status).toBe("uncertain");
    expect(core.state.wallet.pt).toBe(core.config.startPt - 120);
    expect(shop.busy).toBe(true);
  });

  it("gacha 明确失败回滚 PT", () => {
    const { shop, gachaBuy, core } = serviceFixture();
    gachaBuy.mockReturnValueOnce({ ok: false, reason: "装备箱无空槽" });
    expect(shop.requestPurchase("gacha_1").ok).toBe(true);
    shop.tick();
    expect(shop.lastTransaction?.status).toBe("rejected");
    expect(core.state.wallet.pt).toBe(core.config.startPt);
  });
});
