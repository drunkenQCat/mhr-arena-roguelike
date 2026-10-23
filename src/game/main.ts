/**
 * MhwRogue autorun 入口（TSTL bundle 的 entry point）。
 * 装配：配置 → RunCore → 任务安装器（on_frame）→ HUD（on_draw_ui）。
 *
 * 排障约定：boot 阶段落盘 mhw_rogue_boot.json、异常落盘 mhw_rogue_error.json
 * （json.dump_file 写到 <game>/reframework/data/）。脚本日志不进
 * re2_framework_log.txt，这两个文件是"脚本是否加载"的唯一确凿证据。
 */

import { RunCore } from "../core/run_core";
import { drawHud } from "./hud";
import { loadConfig } from "./load_config";
import { QuestInstaller } from "./quest_installer";
import { reframework, rejson, relog } from "./sdk";

const boot: Record<string, unknown> = { stages: [] as string[] };
function mark(stage: string): void {
  (boot.stages as string[]).push(stage);
  boot.ok = true;
  rejson.dump_file("mhw_rogue_boot.json", boot, 2);
}

try {
  mark("entry");
  const config = loadConfig();
  const core = new RunCore(config);
  const installer = new QuestInstaller(config);
  mark("assembled");

  reframework.onFrame(() => installer.tick());
  reframework.onDrawUi(() => {
    installer.tick(); // 站在设置界面里也持续安装
    drawHud(core);
  });
  reframework.onScriptReset(() => {
    core.reset(); // 脚本热重载：丢弃一局状态，重新装配
  });
  mark("hooks-registered");

  relog.info(
    `[MhwRogue] loaded. shop=${config.shop.length} pools=${config.pools.length} ` +
      `startPt=${config.startPt} quest=${config.quest.id}`,
  );
} catch (e) {
  rejson.dump_file("mhw_rogue_error.json", { error: `${e}`, boot }, 2);
  relog.error(`[MhwRogue] boot failed: ${e}`);
}

