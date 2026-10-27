import { RunCore } from "../core/run_core";
import { RunSession } from "../core/run_session";
import { makeQuestPlan } from "../core/quest_plan";
import type { WaveOption } from "../core/run_state";
import { monsterCatalog } from "./default_config";
import { drawHud } from "./hud";
import { loadConfig } from "./load_config";
import { NativeRuntime } from "./native_runtime";
import { QuestInstaller } from "./quest_installer";
import { ShopWindow } from "./shop_window";
import { clockSeconds, reframework, rejson, relog } from "./sdk";

try {
  const config = loadConfig();
  const core = new RunCore(config);
  const spike: WaveOption = { index: 0, typeTag: "M2a", label: "Great Izuchi -> Great Baggi",
    monsters: ["Great Izuchi", "Great Baggi"], tier: "weak", hpMul: 1, dmgMul: 1, rewardMul: 0, rewardPt: 0 };
  const initial = makeQuestPlan(config, monsterCatalog, spike, 1, 0, true);
  const installer = new QuestInstaller(config, initial);
  const runtime = new NativeRuntime(config, installer);
  const session = new RunSession(core, monsterCatalog, runtime);
  const shopWindow = new ShopWindow(session.core, () => session.stage === "Selecting", () => session.shopQuest());
  reframework.onFrame(() => {
    try { runtime.tick(); shopWindow.tick(); session.tick(); }
    catch (error) {
      runtime.shutdown();
      session.stage = "Fault";
      session.message = String(error);
      runtime.report("frame-error", session.message);
    }
  });
  reframework.onDrawUi(() => drawHud(session, runtime, shopWindow));
  reframework.onFrame(() => {
    try { shopWindow.draw(); }
    catch (error) { relog.error(`[MhwRogue] shop window: ${String(error)}`); }
  });
  reframework.onScriptReset(() => runtime.shutdown());
  rejson.dump_file("mhw_rogue_boot.json", { ok: true, version: 2,
    quest: config.quest, route: session.route, startedAt: clockSeconds(), runtimeVerified: false }, 2);
  relog.info(`[MhwRogue] loaded M2. quest=${config.quest.id} template=${config.quest.baseId} route=${session.route}`);
} catch (error) {
  rejson.dump_file("mhw_rogue_error.json", { ok: false, error: String(error), version: 2, at: clockSeconds() }, 2);
  relog.error(`[MhwRogue] boot failed: ${String(error)}`);
}
