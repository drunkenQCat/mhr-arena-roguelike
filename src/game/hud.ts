/**
 * HUD —— 对应 MHW 版 Ui/Hud.cs：常驻状态板 + 手动驱动状态机的开发按钮。
 * 画在 REFramework Script Generated UI 的树节点下（re.on_draw_ui）。
 *
 * 文本一律英文：REFramework v1.5.9 默认字体是 RobotoMedium（无 CJK 字形），
 * 中文在 imgui 里渲染为 '?'。数据层保留中文（sim/策划侧不受影响）；
 * 任务柜里的任务名走游戏引擎字体，不受此限制（见 quest_installer）。
 * M2 起商店/任务选择迁移到这里。
 */

import type { RunCore } from "../core/run_core";
import { imguiApi } from "./sdk";

export function drawHud(core: RunCore): void {
  const open = imguiApi.tree_node("MHW Rogue (MHRise port)");
  if (!open) return;

  const s = core.state;
  imguiApi.text(`Phase: ${s.phase}   Layer: ${s.layer}`);
  imguiApi.text(`PT: ${s.wallet.pt}   Carts: ${s.cartsLeft}/${core.config.maxCarts}`);
  if (s.armor) imguiApi.text(`Armor: ${s.armor}`);
  if (s.activeWave) imguiApi.text(`Wave: ${s.activeWave.label}`);
  imguiApi.separator();

  // ---- Dev buttons (M1 drives the state machine by hand; M2 wires game events) ----
  if (s.phase === "Idle" || s.phase === "GameOver") {
    for (const armor of core.armorOptions()) {
      if (imguiApi.button(`Start run: ${armor}`)) {
        const r = core.startRun(armor);
        imguiApi.text_disabled(`${r.ok ? "OK" : "NG"} ${r.message ?? ""}`);
      }
    }
  } else if (s.phase === "Prep") {
    if (imguiApi.button("Generate quest options (pick 1 of 3)")) {
      for (const o of core.generateChoices()) {
        imguiApi.text_disabled(`#${o.index} ${o.label}  HP x${o.hpMul}  +${o.rewardPt}PT`);
      }
    }
  } else if (s.phase === "Choosing") {
    for (const o of s.currentChoices) {
      if (imguiApi.button(`Pick #${o.index}: ${o.label}`)) core.pickChoice(o.index);
    }
  } else if (s.phase === "Combat") {
    // M2 replaces this with kill detection; kept to hand-drive the loop for now
    if (imguiApi.button("Simulate clear")) imguiApi.text_disabled(core.killWave().message ?? "");
  } else if (s.phase === "Carve") {
    if (imguiApi.button("Return to camp -> next layer")) {
      imguiApi.text_disabled(core.returnToCamp().message ?? "");
    }
  }

  imguiApi.tree_pop();
}
