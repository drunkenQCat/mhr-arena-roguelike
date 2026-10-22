/**
 * MhwRogue autorun 入口（TSTL bundle 的 entry point）。
 * 装配：配置 → RunCore → 任务安装器（on_frame）→ HUD（on_draw_ui）。
 */

import { RunCore } from "../core/run_core";
import { drawHud } from "./hud";
import { loadConfig } from "./load_config";
import { QuestInstaller } from "./quest_installer";
import { reframework, relog } from "./sdk";

const config = loadConfig();
const core = new RunCore(config);
const installer = new QuestInstaller(config);

reframework.onFrame(() => installer.tick());
reframework.onDrawUi(() => {
  installer.tick(); // 站在设置界面里也持续安装
  drawHud(core);
});
reframework.onScriptReset(() => {
  // 脚本热重载：丢弃一局状态与已保留对象，重新装配
  core.reset();
});

relog.info(
  `[MhwRogue] loaded. shop=${config.shop.length} pools=${config.pools.length} ` +
    `startPt=${config.startPt} quest=${config.quest.id}`,
);
