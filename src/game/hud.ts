import type { Result } from "../core/run_core";
import type { RunSession } from "../core/run_session";
import type { NativeRuntime } from "./native_runtime";
import { ShopWindow } from "./shop_window";
import { imguiApi } from "./sdk";

/** Real event-driven M2 controls. No simulated clear / next-layer buttons. */
export function drawHud(session: RunSession, runtime: NativeRuntime, shop: ShopWindow): void {
  if (!imguiApi.tree_node("斗技场肉鸽（单人测试版）")) return;
  const core = session.core;
  const state = core.state;
  const action = (result: Result): void => { if (!result.ok) session.message = result.message ?? "操作失败"; };
  try {
    if (imguiApi.tree_node("开发测试工具（普通游玩无需打开）")) {
    try {
    if (imguiApi.button(`无敌：${runtime.testTools.invincible ? "开" : "关"}`)) runtime.testTools.toggleGod();
    if (imguiApi.button("击杀当前已出场怪物")) runtime.testTools.requestKill();
    imguiApi.text(runtime.testTools.message);
    if (["Idle", "Finished", "Fault"].includes(session.stage) && imguiApi.button("M2a: test 2 native sequential monsters (0 PT)")) {
      const armor = core.armorOptions()[0];
      if (armor) action(session.start(armor, true));
    }
    } finally { imguiApi.tree_pop(); }
    }
    imguiApi.separator();
    imguiApi.text(runtime.ready() ? "原生钩子就绪（仅单人）" : "等待中 / 未就绪");
    imguiApi.text(runtime.status());
    imguiApi.text(`会话: ${session.stage} / 核心: ${state.phase} / 层: ${state.layer}`);
    imguiApi.text(`PT: ${state.wallet.pt} / 猫车: ${state.cartsLeft}/${core.config.maxCarts}`);
    imguiApi.text(`路线: ${session.route} / 出怪: ${session.settings.spawnMode}`);
    imguiApi.text(session.message);
    if (state.activeWave) imguiApi.text(`本层: ${state.activeWave.label}`);
    if (session.stage === "Selecting") {
      imguiApi.separator();
      if (imguiApi.button("打开独立商店窗口")) shop.open();
    }
    imguiApi.separator();
    if (["Idle", "Finished", "Fault"].includes(session.stage)) {
      for (const armor of core.armorOptions()) {
        if (imguiApi.button(`开局：${armor}`)) action(session.start(armor));
      }
      if (imguiApi.button(`切换路线（当前 ${session.settings.route}）`)) {
        session.settings.route = session.settings.route === "reentry" ? "inPlace" : "reentry";
        session.route = session.settings.route;
      }
    }
    if (session.stage === "Selecting") {
      if (shop.busy) {
        imguiApi.text("商店交易进行中，处理完才能选下一波。");
      } else {
      for (const choice of state.currentChoices) {
        imguiApi.text(`HP x${choice.hpMul} / ATK x${choice.dmgMul} / +${choice.rewardPt} PT`);
        if (imguiApi.button(`选择${choice.index + 1}：${choice.label}`)) action(session.choose(choice.index));
      }
      }
    }
    if (session.stage === "Fault" || session.stage === "AwaitQuest") {
      if (imguiApi.button("重试原生接取（村庄且未接任务）")) action(session.retryPost());
    }
    if (!["Idle", "Finished"].includes(session.stage)) {
      if (imguiApi.button("终止本局 / 恢复原生结算")) {
        try { session.stop(); } catch (error) { session.message = String(error); }
      }
    }
  } finally { imguiApi.tree_pop(); }
}
