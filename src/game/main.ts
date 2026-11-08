import { MultiplayerRun } from "./multiplayer_run";
import { MultiplayerEntry } from "./multiplayer_entry";
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
import { startupRecoveryPending } from "./equip_wear";
import { BuffService } from "./buff_service";
import { GachaService } from "./gacha";
import { DEFAULT_BUFF_AMOUNTS, type BuffAmounts } from "../core/config";
import type { ServiceEffects } from "./shop_window";
import type { BuffKind } from "./buff_service";
import { clockSeconds, reframework, rejson, relog } from "./sdk";
import { entryHostTestScope } from "./entry_host_scope";

try {
  const config = loadConfig();
  let core = new RunCore(config);
  const spike: WaveOption = { index: 0, typeTag: "M2a", label: "Great Izuchi -> Great Baggi",
    monsters: ["Great Izuchi", "Great Baggi"], tier: "weak", hpMul: 1, dmgMul: 1, rewardMul: 0, rewardPt: 0 };
  const initial = makeQuestPlan(config, monsterCatalog, spike, 1, 0, true);
  const installer = new QuestInstaller(config, initial);
  const gacha = new GachaService(config.gachaPools ?? {}, { rollIndex: (w) => core.rollWeighted(w) });
  let runtime = new NativeRuntime(config, installer, gacha);
  let session = new RunSession(core, monsterCatalog, runtime);
  // 上局中断留下的未恢复状态（重载/崩溃）：回到村庄后由 session tick 自动恢复。
  if (startupRecoveryPending()) {
    session.armStartupRestore();
    relog.warn("[MhwRogue] 检测到未恢复的上局开局状态；回到村庄后自动恢复原装备");
  }
  // M3.6 翻盘服务：单轮增益（叠加购买）+ 装备抽取（发件并入局末清理）
  const amounts: BuffAmounts = config.buffAmounts ?? DEFAULT_BUFF_AMOUNTS;
  const buffs = new BuffService(amounts);
  const services: ServiceEffects = {
    buffBuy: (kind: BuffKind) => buffs.addPending(kind),
    gachaBuy: (poolId: string) => {
      const result = gacha.roll(poolId);
      if (result.ok && !result.reused) session.armStartupRestore();
      return result;
    },
    hasGachaPool: (poolId: string) => gacha.hasPool(poolId),
  };
  let shopWindow = new ShopWindow(session.core, () => session.canShop(), () => session.shopQuest(), services);
  let entryAttached = false;
  let previousRun: ReturnType<RunSession["runSummary"]> | null = null;
  const multiplayerEntry = new MultiplayerEntry(config, monsterCatalog, () => !entryAttached &&
    ((session.stage === "Preparing" && session.startupStatus.prepared) ||
      (["Idle", "Finished", "Fault"].includes(session.stage) && !session.startupStatus.restorePending)), undefined, {
    prepared: () => session.startupStatus.prepared,
    prepare: (plan, entryInstaller, armor) => {
      if (session.stage !== "Preparing") {
        const entryConfig = { ...config, quest: { ...config.quest, id: plan.questId } };
        core.replaceConfig(entryConfig); runtime.rebind(entryConfig, entryInstaller);
      }
      const result = session.prepareMultiplayer(plan, armor);
      if (!result.ok) throw new Error(result.message ?? "联机个人开局准备失败");
    },
    cancel: () => { if (session.stage === "Preparing") session.stop(); },
  });
  let webConsole: WebConsoleBridge | null = null;
  try { webConsole = new WebConsoleBridge(session, runtime, shopWindow, () => buffs.diagnostic(), undefined, multiplayerEntry, () => previousRun); }
  catch (error) { relog.warn(`[MhwRogue] webconsole unavailable: ${String(error)}`); }
  // 离线队友调研 §6C：混合局的权威人数来自 PartySession 名单（bridge 自建或注入）。
  runtime.setPartySizeSource(() => webConsole?.partyRosterSize() ?? null);
  let lastBuffState = "";
  let lastBuffPoll = -1;
  let multiplayerRun: MultiplayerRun | null = null;
  reframework.onFrame(() => {
    try {
      // Production multiplayer: adopt the already ACKed and posted entry on every peer.
      // Only the host owns progression; guests mirror business state and stage native slots.
      if (!entryAttached && (!session.startupStatus.restorePending || session.startupStatus.prepared) &&
          ["Idle", "Preparing", "Finished"].includes(session.stage) && !shopWindow.busy) {
        const entry = multiplayerEntry.runEntry();
        if (entry) {
          entryAttached = true;
          if (!session.startupStatus.prepared || session.stage !== "Preparing") throw new Error("联机个人开局准备未完成");
          multiplayerRun = new MultiplayerRun(entry, core.config, monsterCatalog, session, runtime, () => shopWindow.busy);
          runtime.setMultiplayer(multiplayerRun);
          const adopted = session.adoptMultiplayerEntry(entry.plan);
          if (!adopted.ok) throw new Error(adopted.message ?? "Cannot adopt multiplayer entry");
        }
      }
      // Explicit debug-only one-host slice. Never adopts guests, real teams, or
      // unrelated quests, and does not redo equipment/pouch startup in a posted quest.
      if (!entryAttached && config.runtime?.debugMode && !session.startupStatus.restorePending &&
          ["Idle", "Finished"].includes(session.stage) && !shopWindow.busy && entryHostTestScope()) {
        const entry = multiplayerEntry.hostTestEntry();
        if (entry) {
          entryAttached = true;
          runtime.shutdown(); const nativeUi = webConsole?.newScriptSession();
          const entryConfig = { ...config, quest: { ...config.quest, id: entry.plan.questId } };
          core = new RunCore(entryConfig);
          runtime = new NativeRuntime(entryConfig, entry.installer, gacha, true);
          runtime.tick();
          session = new RunSession(core, monsterCatalog, runtime);
          const adopted = session.adoptPostedEntry(entry.plan);
          if (!adopted.ok) throw new Error(adopted.message ?? "Cannot adopt entry quest");
          shopWindow = new ShopWindow(core, () => session.canShop(), () => session.shopQuest(), services);
          webConsole = new WebConsoleBridge(session, runtime, shopWindow, () => buffs.diagnostic(), undefined, multiplayerEntry, () => previousRun, nativeUi);
        }
      }
      runtime.tick(); shopWindow.tick(); session.tick();
      if (multiplayerRun) multiplayerRun.tick(); else multiplayerEntry.tick();
      const r = session.readingSnapshot;
      if (["Finished", "Fault"].includes(session.stage) && !shopWindow.busy && !session.startupStatus.restorePending &&
          r?.canPost && !r.quest && r.players.length > 0 && (entryAttached || core.config.quest.id === 900103)) {
        previousRun = session.runSummary(); runtime.report("run-settlement",previousRun);
        buffs.shutdown(); multiplayerEntry.resetForNextRun();
        runtime.rebind(config, installer); multiplayerRun = null; entryAttached = false;
        core = new RunCore(config); session = new RunSession(core, monsterCatalog, runtime);
        shopWindow = new ShopWindow(core, () => session.canShop(), () => session.shopQuest(), services);
        const nativeUi = webConsole?.newScriptSession();
        webConsole = new WebConsoleBridge(session, runtime, shopWindow, () => buffs.diagnostic(), undefined, multiplayerEntry, () => previousRun, nativeUi);
        runtime.report("multiplayer-ready-for-new-run", { restored: true });
      }
      buffs.tick(session.readingSnapshot, { stage: session.stage, layer: core.state.layer, questId: core.config.quest.id, multiplayer: runtime.multiplayerValid() || session.stage === "Preparing" });
      const sampleTime = session.readingSnapshot?.time ?? -1;
      if (sampleTime !== lastBuffPoll) {
        lastBuffPoll = sampleTime;
        const buffState = rejson.dump_string(buffs.diagnostic());
        if (buffState !== lastBuffState) { lastBuffState = buffState; runtime.report("buff-state", buffs.diagnostic()); }
      }
    }
    catch (error) {
      if (session.multiplayerRole) session.failMultiplayer(String(error));
      else {
        runtime.shutdown(); session.stage = "Fault"; session.message = String(error);
        runtime.report("frame-error", session.message);
      }
    }
  });
  reframework.onDrawUi(() => drawHud(session, runtime, shopWindow));
  reframework.onFrame(() => webConsole?.tick());
  reframework.onFrame(() => {
    try { shopWindow.draw(); }
    catch (error) { relog.error(`[MhwRogue] shop window: ${String(error)}`); }
  });
  reframework.onScriptReset(() => {
    multiplayerEntry.shutdown();
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
