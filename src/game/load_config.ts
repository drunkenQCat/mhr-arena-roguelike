/**
 * 配置装载：运行时优先读游戏目录的 mhw_rogue_config.json（策划热调数值用），
 * 不存在则回退到构建期内嵌的 data/rogue_config.json。
 * 两条路径都过 validateConfig，不允许半配置进游戏。
 */

import { validateConfig, type RogueConfig } from "../core/config";
import { rejson, relog } from "./sdk";
// 由 scripts/build-config.js 在 npm run build 前生成（.gitignore 排除）
import { defaultConfig } from "./default_config";
import { ConfigStore } from "./config_store";

export function loadConfig(): RogueConfig {
  // Recovery errors must escape the fallback block. Starting with embedded
  // defaults would discard an unresolved configuration transaction.
  if(new ConfigStore().recover())relog.warn("[MhwRogue] 已恢复未完成联机提案之前的完整配置");
  try {
    const fromDisk = rejson.load_file("mhw_rogue_config.json");
    if (fromDisk && typeof fromDisk === "object") {
      const cfg = validateConfig(fromDisk);
      relog.info("[MhwRogue] config: mhw_rogue_config.json (runtime override)");
      return cfg;
    }
  } catch (e) {
    relog.warn(`[MhwRogue] runtime config parse failed, falling back to embedded: ${e}`);
  }
  return validateConfig(defaultConfig);
}
