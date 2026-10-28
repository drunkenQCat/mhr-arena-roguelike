import { beforeEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { validateConfig } from "../core/config";
import { RunCore } from "../core/run_core";
import { RunSession, type RuntimeReading, type SessionPort } from "../core/run_session";
import type { NativeRuntime } from "./native_runtime";
import { ShopWindow } from "./shop_window";

const host = vi.hoisted(() => ({ now: 10, files: {} as Record<string, any>, count: 0, failWrite: "" }));
vi.mock("./sdk", () => ({ clockSeconds: () => host.now,
  refFs: { read: (path: string) => host.files[path] === undefined ? "" : JSON.stringify(host.files[path]),
    write: (path: string, text: string) => { if (path !== host.failWrite) host.files[path] = JSON.parse(text); } },
  rejson: { dump_string: (body: unknown) => JSON.stringify(body), load_string: (s: string) => { try { return JSON.parse(s); } catch { return null; } },
    dump_file: (path: string, body: unknown) => { if (path === host.failWrite) return false; host.files[path] = JSON.parse(JSON.stringify(body)); return true; } }, imguiApi: {} }));
vi.mock("./item_grant", () => ({ canTrade: () => true, pouchCount: () => host.count,
  grantItem: () => ({ granted: true, before: host.count++, after: host.count }), grantFill: vi.fn() }));
vi.mock("./native_cart", () => ({ restoreNativeCart: vi.fn() }));
import { WebConsoleBridge } from "./webconsole_bridge";

function fixture() {
  const cfg = validateConfig(JSON.parse(readFileSync(new URL("../../data/rogue_config.json", import.meta.url), "utf8")));
  cfg.runtime = { ...cfg.runtime!, route: "inPlace", carveSeconds: 2, campDwellSeconds: 1 };
  const core = new RunCore(cfg, 42);
  let reading: RuntimeReading = { time: host.now, quest: null, players: [{ id: 0, position: { x: 10, y: 20, z: 30 } }],
    enemies: [], online: false, deaths: 0, canPost: true };
  const port: SessionPort = { now: () => host.now, ready: () => true, read: () => reading,
    publish() {}, policy() {}, post() {}, cancelPost() {}, postingError: () => null, finish() {}, takeDeaths: () => [], report() {} };
  const session = new RunSession(core, { Izuchi: { id: 98, cn: "镰鼬龙王" },
    ...JSON.parse(readFileSync(new URL("../../data/monster_ids.json", import.meta.url), "utf8")) }, port);
  const tools = { invincible: false, message: "ok", toggleGod: vi.fn(() => { tools.invincible = !tools.invincible; }), requestKill: vi.fn() };
  const runtime = { status: () => "ready", testTools: tools } as unknown as NativeRuntime;
  const shop = new ShopWindow(core, () => session.canShop(), () => session.shopQuest());
  const bridge = new WebConsoleBridge(session, runtime, shop);
  function tick() { host.now++; reading.time = host.now; session.tick(); for (let i = 0; i < 12; i++) bridge.tick(); }
  function command(cmd: string, extra: Record<string, unknown> = {}, id = `${cmd}-${host.now}`) {
    host.files["webconsole_cmd.json"] = { id, bridgeId: bridge.bridgeId,
      questUnique: reading.quest?.unique ?? null, waveToken: session.plan?.token ?? null, cmd, ...extra };
    tick(); return host.files["webconsole_results.json"]?.last;
  }
  const state = () => host.files["webconsole_state.json"];
  return { cfg, core, session, tools, shop, bridge, command, tick, state, reading };
}
beforeEach(() => { host.now = 10; host.files = {}; host.count = 0; host.failWrite = ""; });

it("updates wave, position, gathering and shop eligibility with no PT change at preparation", () => {
  const f = fixture(); f.tick(); f.session.start(f.cfg.armorOptions[0]!); f.tick();
  expect(f.state().shopAvailable).toBe(true);
  const choice = f.core.state.currentChoices.find((c) => c.monsters.length === 1)!;
  expect(f.command("choose", { index: choice.index }).status).toBe("applied");
  f.reading.quest = { id: f.cfg.quest.id, unique: 42, playing: true, status: "play" }; f.reading.canPost = false; f.tick();
  f.reading.enemies = [{ uid: 9, typeId: f.session.plan!.monsterIds[0]!, dead: true, captured: false }]; f.tick();
  expect(f.state().sessionStage).toBe("Carve"); expect(f.state().shopAvailable).toBe(false);
  const pt = f.state().pt;
  f.reading.players[0]!.position = { x: 200, y: 20, z: 30 }; f.tick(); f.tick();
  expect(f.state().preparation.players[0].campDistance).toBe(190);
  f.reading.players[0]!.position = { x: 10, y: 20, z: 30 }; f.tick(); f.tick();
  expect(f.state().pt).toBe(pt); expect(f.state().layer).toBe(2);
  expect(f.state().sessionStage).toBe("Selecting"); expect(f.state().shopAvailable).toBe(true);
  expect(f.state().shop["基础补给"].find((e: any) => e.id === "potion").canBuy).toBe(true);
  f.reading.players[0]!.position.x = 200; f.tick();
  expect(f.state().shopAvailable).toBe(false);
});

it("refreshes actual inventory even when PT, phase and config stay unchanged", () => {
  const f = fixture(); f.tick(); f.session.start(f.cfg.armorOptions[0]!); f.tick();
  host.count = 10; f.tick();
  const potion = () => f.state().shop["基础补给"].find((e: any) => e.id === "potion");
  expect(potion().canBuy).toBe(false); host.count = 2; f.tick();
  expect(potion().owned).toBe(2); expect(potion().canBuy).toBe(true);
});

it("replaces a queued purchase receipt with the verified transaction result", () => {
  const f = fixture(); f.tick(); f.session.start(f.cfg.armorOptions[0]!); f.tick();
  const before = f.core.state.wallet.pt;
  expect(f.command("buy", { itemId: "potion" }, "purchase-1").status).toBe("queued");
  f.shop.tick(); f.tick();
  const receipt = host.files["webconsole_results.json"].history.find((r: any) => r.id === "purchase-1");
  expect(receipt.status).toBe("applied"); expect(f.core.state.wallet.pt).toBe(before - 10);
  expect(f.command("buy", { itemId: "potion" }, "purchase-1").status).toBe("applied");
  f.shop.tick(); expect(f.core.state.wallet.pt).toBe(before - 10);
});

it("rejects stale or missing session identities, writes the matching receipt and consumes the slot", () => {
  const f = fixture(); f.tick();
  expect(f.command("setInvincible", { bridgeId: "old", value: true }).status).toBe("rejected");
  expect(f.tools.toggleGod).not.toHaveBeenCalled();
  expect(host.files["webconsole_cmd.json"]).toEqual({});
  expect(f.command("killAll", { questUnique: 999 }).message).toContain("任务实例");
});

it("deduplicates requests across intervening commands and failed receipt writes", () => {
  const f = fixture(); f.tick();
  host.failWrite = "webconsole_results.json";
  f.command("setInvincible", { value: true }, "once"); f.tick();
  expect(f.tools.toggleGod).toHaveBeenCalledTimes(1);
  host.failWrite = ""; f.tick(); f.command("getConfig"); f.command("setInvincible", { value: true }, "once");
  expect(f.tools.toggleGod).toHaveBeenCalledTimes(1);
});

it("returns authoritative config and rejects conflicts or failed persistence without mutating it", () => {
  const f = fixture(); f.tick();
  host.files["mhw_rogue_config.json"] = { startPt: 999 };
  expect(f.command("getConfig").config.startPt).toBe(f.cfg.startPt);
  const edited = { ...f.cfg, startPt: 250 };
  expect(f.command("submitConfig", { config: edited, configVersion: 9 }).status).toBe("rejected");
  host.failWrite = "mhw_rogue_config.json";
  expect(f.command("submitConfig", { config: edited, configVersion: 0 }).status).toBe("rejected");
  expect(f.core.config.startPt).toBe(f.cfg.startPt);
  host.failWrite = "";
  expect(f.command("submitConfig", { config: edited, configVersion: 0 }).configVersion).toBe(1);
});

it("freezes run rules and the current wave, but stages new rules for the next run", () => {
  const f = fixture(); f.tick(); f.session.start(f.cfg.armorOptions[0]!); f.tick();
  f.session.choose(0); const wave = f.core.state.activeWave;
  const edited = { ...f.cfg, startPt: 999, maxCarts: 8, scaling: { ...f.cfg.scaling, hpBase: 0.9 } };
  expect(f.command("submitConfig", { config: edited, configVersion: 0 }).status).toBe("applied");
  expect(f.core.config.maxCarts).toBe(f.cfg.maxCarts); expect(f.core.state.activeWave).toBe(wave);
  expect(f.core.config.scaling.hpBase).toBe(0.9);
  f.session.stop(); f.tick(); expect(f.session.start(f.cfg.armorOptions[0]!).ok).toBe(true);
  expect(f.core.state.wallet.pt).toBe(999); expect(f.core.state.cartsLeft).toBe(8);
});
