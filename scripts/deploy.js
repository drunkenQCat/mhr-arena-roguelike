// 构建后自动部署：把 reframework/autorun/mhw_rogue.lua 拷进 Rise 游戏目录。
// 游戏目录探测顺序：命令行参数 > 环境变量 MHR_GAME_DIR > Steam libraryfolders.vdf 扫描 > 默认安装路径。
// 内容相同则跳过（避免无意义的热重载）；游戏运行中也允许拷贝（REFramework 监视 autorun 自动重载，否则重启游戏生效）。
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { execSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const BUNDLE = path.join(root, "reframework", "autorun", "mhw_rogue.lua");
const APP_ID = "1446780";
const GAME_FOLDER = "MonsterHunterRise";

function findGameDirFromSteam() {
  const steamRoots = [
    "C:\\Program Files (x86)\\Steam",
    "D:\\Steam", "E:\\Steam", "D:\\SteamLibrary", "E:\\SteamLibrary",
  ];
  const libraries = new Set();
  for (const s of steamRoots) {
    const vdf = path.join(s, "steamapps", "libraryfolders.vdf");
    if (!fs.existsSync(vdf)) continue;
    // libraryfolders.vdf 里 "path" "盘符:\\..." 逐行出现，正则提取即可
    for (const m of fs.readFileSync(vdf, "utf8").matchAll(/"path"\s+"([^"]+)"/g)) {
      libraries.add(m[1].replace(/\\\\/g, "\\"));
    }
  }
  for (const lib of libraries) {
    const candidate = path.join(lib, "steamapps", "common", GAME_FOLDER);
    if (fs.existsSync(path.join(lib, "steamapps", `appmanifest_${APP_ID}.acf`)) && fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function findGameDir() {
  const arg = process.argv[2];
  if (arg) return path.resolve(arg);
  if (process.env.MHR_GAME_DIR) return path.resolve(process.env.MHR_GAME_DIR);
  const fromSteam = findGameDirFromSteam();
  if (fromSteam) return fromSteam;
  return "C:\\Program Files (x86)\\Steam\\steamapps\\common\\MonsterHunterRise";
}

function isGameRunning() {
  try {
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
    console.log(`SKIP 已是最新：${target}`);
    return;
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, src);
  console.log(`DEPLOY ${src.length} bytes -> ${target}`);

  if (isGameRunning()) {
    console.log("NOTE 游戏正在运行：REFramework 应已热重载 autorun；UI 未变化就重启游戏。");
  }
}

main();
