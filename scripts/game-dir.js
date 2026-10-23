// 游戏目录探测（deploy.js / gen-enums.js 共用）。
// 探测顺序：命令行参数 > 环境变量 MHR_GAME_DIR > Steam libraryfolders.vdf 扫描 > 默认安装路径。
"use strict";
const fs = require("node:fs");
const path = require("node:path");

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

module.exports = { findGameDir };
