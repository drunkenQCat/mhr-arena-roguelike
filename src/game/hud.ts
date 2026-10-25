import type { Result } from "../core/run_core";
import type { RunSession } from "../core/run_session";
import type { NativeRuntime } from "./native_runtime";
import { imguiApi } from "./sdk";

/** Real event-driven M2 controls. No simulated clear / next-layer buttons. */
export function drawHud(session: RunSession, runtime: NativeRuntime): void {
  if (!imguiApi.tree_node("MHR Arena Roguelike - M2")) return;
  const core = session.core;
  const state = core.state;
  const action = (result: Result): void => { if (!result.ok) session.message = result.message ?? "Action failed"; };
  try {
    imguiApi.text("TEST TOOLS (900101/900102, solo only)");
    if (imguiApi.button(`Invincible: ${runtime.testTools.invincible ? "ON" : "OFF"}`)) runtime.testTools.toggleGod();
    if (imguiApi.button("Kill all spawned bosses now")) runtime.testTools.requestKill();
    imguiApi.text(runtime.testTools.message);
    imguiApi.separator();
    imguiApi.text(runtime.ready() ? "Native hooks ready (solo)" : "Waiting / not ready");
    imguiApi.text(runtime.status());
    imguiApi.text(`Session: ${session.stage} / Core: ${state.phase} / Layer: ${state.layer}`);
    imguiApi.text(`PT: ${state.wallet.pt} / Carts: ${state.cartsLeft}/${core.config.maxCarts}`);
    imguiApi.text(`Route: ${session.route} / Spawn: ${session.settings.spawnMode}`);
    imguiApi.text(session.message);
    if (state.activeWave) imguiApi.text(`Wave: ${state.activeWave.label}`);
    imguiApi.separator();
    if (["Idle", "Finished", "Fault"].includes(session.stage)) {
      for (const armor of core.armorOptions()) {
        if (imguiApi.button(`Start run: ${armor}`)) action(session.start(armor));
      }
      if (imguiApi.button("M2a: test 2 native sequential monsters (0 PT)")) {
        const armor = core.armorOptions()[0];
        if (armor) action(session.start(armor, true));
      }
      if (imguiApi.button(`Switch route (current ${session.settings.route})`)) {
        session.settings.route = session.settings.route === "reentry" ? "inPlace" : "reentry";
        session.route = session.settings.route;
      }
    }
    if (session.stage === "Selecting") {
      for (const choice of state.currentChoices) {
        imguiApi.text(`HP x${choice.hpMul} / ATK x${choice.dmgMul} / +${choice.rewardPt} PT`);
        if (imguiApi.button(`Pick #${choice.index + 1}: ${choice.label}`)) action(session.choose(choice.index));
      }
    }
    if (session.stage === "Fault" || session.stage === "AwaitQuest") {
      if (imguiApi.button("Retry native post (village, no accepted quest)")) action(session.retryPost());
    }
    if (!["Idle", "Finished"].includes(session.stage)) {
      if (imguiApi.button("Stop run / release native return flow")) {
        try { session.stop(); } catch (error) { session.message = String(error); }
      }
    }
  } finally { imguiApi.tree_pop(); }
}
