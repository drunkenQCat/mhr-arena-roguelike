// 构建后自动部署：把 reframework/autorun/mhw_rogue.lua 拷进 Rise 游戏目录。
// 游戏目录探测顺序：命令行参数 > 环境变量 MHR_GAME_DIR > Steam libraryfolders.vdf 扫描 > 默认安装路径。
// 内容相同则跳过（避免无意义的热重载）；游戏运行中也允许拷贝（REFramework 监视 autorun 自动重载，否则重启游戏生效）。
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { execSync } = require("node:child_process");
const { findGameDir } = require("./game-dir");

const root = path.resolve(__dirname, "..");
const BUNDLE = path.join(root, "reframework", "autorun", "mhw_rogue.lua");

// 差异复制：内容相同则 SKIP；返回是否发生部署
function copyIfChanged(fromRoot, relSrc, gameDir, relDst, hint) {
  const srcPath = path.join(fromRoot, relSrc);
  const dstPath = path.join(gameDir, relDst);
  if (!fs.existsSync(srcPath)) {
    console.warn(`WARN 缺少 ${relSrc}（先构建对应产物）`);
    return false;
  }
  const src = fs.readFileSync(srcPath);
  if (fs.existsSync(dstPath) && src.equals(fs.readFileSync(dstPath))) {
    console.log(`SKIP ${relDst} 已是最新`);
    return true;
  }
  fs.mkdirSync(path.dirname(dstPath), { recursive: true });
  try {
    fs.writeFileSync(dstPath, src);
    console.log(`DEPLOY ${src.length} bytes -> ${dstPath}${hint ? `  (${hint})` : ""}`);
    return true;
  } catch (e) {
    // DLL 被游戏进程锁定时写入失败属正常：提示重启游戏
    console.error(`FAIL 部署 ${relDst}: ${e.message}（游戏运行中可能锁定文件，重启游戏前请勿依赖该产物）`);
    return false;
  }
}

function isGameRunning() {  try {
    const out = execSync("tasklist /FI \"IMAGENAME eq MonsterHunterRise.exe\"", { encoding: "utf8" });
    return /MonsterHunterRise\.exe/i.test(out);
  } catch {
    return false;
  }
}

function main() {
  if (!fs.existsSync(BUNDLE)) {
    console.error(`FAIL bundle 不存在：${BUNDLE}（先跑 npm run build）`);
    process.exit(1);
  }
  const gameDir = findGameDir();
  const target = path.join(gameDir, "reframework", "autorun", "mhw_rogue.lua");
  if (!fs.existsSync(path.join(gameDir, "MonsterHunterRise.exe"))) {
    console.error(`FAIL ${gameDir} 不像 Rise 安装目录（缺 MonsterHunterRise.exe）。`);
    console.error("     可用参数或环境变量指定：node scripts/deploy.js <游戏目录> / MHR_GAME_DIR=...");
    process.exit(1);
  }

  const src = fs.readFileSync(BUNDLE);
  if (fs.existsSync(target) && src.equals(fs.readFileSync(target))) {
    console.log(`SKIP ${target} 已是最新`);
  } else {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, src);
    console.log(`DEPLOY ${src.length} bytes -> ${target}`);
  }

  // webconsole 插件 + 单 HTML 控制台（部署到 reframework/plugins，随游戏启动提供 HTTP 服务）。
  // 无论 bundle 是否变化都检查——前端/插件迭代经常单独进行。
  copyIfChanged(root, path.join("native", "webconsole", "webconsole.dll"), gameDir, path.join("reframework", "plugins", "webconsole.dll"), "游戏重启后生效（原生插件随启动加载）");
  copyIfChanged(root, path.join("console", "dist", "index.html"), gameDir, path.join("reframework", "plugins", "console.html"), "打开 http://127.0.0.1:11777/console");

  // REFramework 字体开关：该文件存在 => 默认 imgui 字体切到内嵌百度字体（中文可渲染）。
  const mode = path.join(gameDir, "reframework_pictographic.mode");
  if (!fs.existsSync(mode)) {
    fs.writeFileSync(mode, "Presence of this file makes REFramework load its embedded CJK font.\n");
    console.log(`DEPLOY ${mode} (CJK font switch)`);
  }

  if (isGameRunning()) {
    console.log("NOTE Game is running. In REFramework > ScriptRunner click Reset scripts to reload; copying alone does not reload Lua.");
  }
}

main();
