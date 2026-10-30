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
import { WebConsoleBridge } from "./webconsole_bridge";
import { loadStartupState } from "./equip_wear";
import { BuffService } from "./buff_service";
import { GachaService } from "./gacha";
import { DEFAULT_BUFF_AMOUNTS, type BuffAmounts } from "../core/config";
import type { ServiceEffects } from "./shop_window";
import type { BuffKind } from "./buff_service";
import { clockSeconds, reframework, rejson, relog } from "./sdk";

try {
  const config = loadConfig();
  const core = new RunCore(config);
  const spike: WaveOption = { index: 0, typeTag: "M2a", label: "Great Izuchi -> Great Baggi",
    monsters: ["Great Izuchi", "Great Baggi"], tier: "weak", hpMul: 1, dmgMul: 1, rewardMul: 0, rewardPt: 0 };
  const initial = makeQuestPlan(config, monsterCatalog, spike, 1, 0, true);
  const installer = new QuestInstaller(config, initial);
  const gacha = new GachaService(config.gachaPools ?? {}, { rollIndex: (w) => core.rollWeighted(w) });
  const runtime = new NativeRuntime(config, installer, gacha);
  const session = new RunSession(core, monsterCatalog, runtime);
  // 上局中断留下的未恢复状态（重载/崩溃）：回到村庄后由 session tick 自动恢复。
  if (loadStartupState()) {
    session.armStartupRestore();
    relog.warn("[MhwRogue] 检测到未恢复的上局开局状态；回到村庄后自动恢复原装备");
  }
  // M3.6 翻盘服务：单轮增益（叠加购买）+ 装备抽取（发件并入局末清理）
  const amounts: BuffAmounts = config.buffAmounts ?? DEFAULT_BUFF_AMOUNTS;
  const buffs = new BuffService(amounts);
  const services: ServiceEffects = {
    buffBuy: (kind: BuffKind) => buffs.addPending(kind),
    gachaBuy: (poolId: string) => gacha.roll(poolId),
    hasGachaPool: (poolId: string) => gacha.hasPool(poolId),
  };
  const shopWindow = new ShopWindow(session.core, () => session.canShop(), () => session.shopQuest(), services);
  let webConsole: WebConsoleBridge | null = null;
  try { webConsole = new WebConsoleBridge(session, runtime, shopWindow); }
  catch (error) { relog.warn(`[MhwRogue] webconsole unavailable: ${String(error)}`); }
  let lastBuffState = "";
  let lastBuffPoll = -1;
  reframework.onFrame(() => {
    try {
      runtime.tick(); shopWindow.tick(); session.tick();
      buffs.tick(session.readingSnapshot, { stage: session.stage, layer: core.state.layer, questId: config.quest.id });
      const sampleTime = session.readingSnapshot?.time ?? -1;
      if (sampleTime !== lastBuffPoll) {
        lastBuffPoll = sampleTime;
        const buffState = rejson.dump_string(buffs.diagnostic());
        if (buffState !== lastBuffState) { lastBuffState = buffState; runtime.report("buff-state", buffs.diagnostic()); }
      }
    }
    catch (error) {
      runtime.shutdown();
      session.stage = "Fault";
      session.message = String(error);
      runtime.report("frame-error", session.message);
    }
  });
  reframework.onDrawUi(() => drawHud(session, runtime, shopWindow));
  reframework.onFrame(() => webConsole?.tick());
  reframework.onFrame(() => {
    try { shopWindow.draw(); }
    catch (error) { relog.error(`[MhwRogue] shop window: ${String(error)}`); }
  });
  reframework.onScriptReset(() => {
    buffs.shutdown();
    runtime.shutdown();
    webConsole?.newScriptSession(); // Reset 后新桥会话：旧页面命令按 bridgeId 拒绝
  });
  rejson.dump_file("mhw_rogue_boot.json", { ok: true, version: 2,
    quest: config.quest, route: session.route, startedAt: clockSeconds(), runtimeVerified: false }, 2);
  relog.info(`[MhwRogue] loaded M2. quest=${config.quest.id} template=${config.quest.baseId} route=${session.route}`);
} catch (error) {
  rejson.dump_file("mhw_rogue_error.json", { ok: false, error: String(error), version: 2, at: clockSeconds() }, 2);
  relog.error(`[MhwRogue] boot failed: ${String(error)}`);
}
