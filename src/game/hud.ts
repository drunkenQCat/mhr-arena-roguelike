/**
 * HUD —— 对应 MHW 版 Ui/Hud.cs：常驻状态板 + 手动驱动状态机的开发按钮。
 * 画在 REFramework Script Generated UI 的树节点下（re.on_draw_ui）。
 * M2 起商店/任务选择迁移到这里。
 */

import type { RunCore } from "../core/run_core";
import { imguiApi } from "./sdk";

export function drawHud(core: RunCore): void {
  const open = imguiApi.tree_node("MHW Rogue（MHRise 移植版）");
  if (!open) return;

  const s = core.state;
  imguiApi.text(`阶段: ${s.phase}   层: ${s.layer}`);
  imguiApi.text(`PT: ${s.wallet.pt}   猫车: ${s.cartsLeft}/${core.config.maxCarts}`);
  if (s.armor) imguiApi.text(`装备: ${s.armor}`);
  if (s.activeWave) imguiApi.text(`本层: ${s.activeWave.label}`);
  imguiApi.separator();

  // ---- 开发按钮（M1 手动驱动状态机；M2 起由游戏事件驱动）----
  if (s.phase === "Idle" || s.phase === "GameOver") {
    for (const armor of core.armorOptions()) {
      if (imguiApi.button(`开局：${armor}`)) {
        const r = core.startRun(armor);
        imguiApi.text_disabled(`${r.ok ? "OK" : "NG"} ${r.message ?? ""}`);
      }
    }
  } else if (s.phase === "Prep") {
    if (imguiApi.button("生成任务选项（三选一）")) {
      for (const o of core.generateChoices()) {
        imguiApi.text_disabled(`选项${o.index}: ${o.label}  HPx${o.hpMul}  +${o.rewardPt}PT`);
      }
    }
  } else if (s.phase === "Choosing") {
    for (const o of s.currentChoices) {
      if (imguiApi.button(`选${o.index}: ${o.label}`)) core.pickChoice(o.index);
    }
  } else if (s.phase === "Combat") {
    // M2 接入讨伐检测后移除；当前用于手动推进状态机
    if (imguiApi.button("模拟讨伐完成")) imguiApi.text_disabled(core.killWave().message ?? "");
  } else if (s.phase === "Carve") {
    if (imguiApi.button("返回起始点 → 下一层")) {
      imguiApi.text_disabled(core.returnToCamp().message ?? "");
    }
  }

  imguiApi.tree_pop();
}
