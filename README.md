# MHR Arena Roguelike（MHW Roguelike 的 Rise 移植版）

Monster Hunter Rise (REFramework v1.5.9.1 / game 16.0.2.0) 的斗技场连续狩猎 Roguelike mod。
脚本以 **TypeScript** 编写，经 [TypeScriptToLua](https://github.com/TypeScriptToLua/TypeScriptToLua)
编译为单个 Lua 文件 `reframework/autorun/mhw_rogue.lua`。迁移方案与调研见
[docs/migration.md](docs/migration.md)；前代 MHW/C# 实现见 `../mhw-moddev`（已冻结）。

## 结构

```
src/core/    纯逻辑（状态机/商店/抽卡/公式）——零游戏依赖，vitest 直测
src/game/    REFramework 交互层：sdk.ts 是全局 API 的唯一入口（Platform 纪律）
data/        数值唯一真源：rogue_config.json + monster_ids.json
reframework/ autorun/ 编译产物 + free_arena 研究脚本（历史记录，勿删）
```

## SDK 自动生成

`sdk-dump/Enums_Internal.hpp` 是 REFramework 自动导出的引擎 RTTI 枚举全量快照
（游戏 16.0.2.0 已停更，一次 dump 永久有效，换版本时重拷并重跑 `npm run gen`）。
`scripts/gen-enums.js` 按**引用闭环**生成 `src/game/gen/enums/`（一枚举一文件）；
`scripts/gen-types.js` 读 `sdk-dump/sdk_types.json`（`reframework/autorun-probe/sdk_type_probe.lua`
的一次性实机探测产物：237 个 snow.* 类型的字段偏移/类型/方法签名）生成带精确
get_field/call 重载的类型接口。两条生成链都是**引用闭环**：源码 import 的 +
`data/gen_allowlist.txt` 列名的才会生成——TSTL 的 luaBundle 会打包编译集内
全部文件，全量生成 1418 个枚举会把 bundle 撑到 820KB，闭环后只有 ~64-104KB。
字段名拼错、返回值错用现在都是 tsc 编译期错误（installer 已消费生成类型）。

## 命令

```bash
npm ci
npm run typecheck   # tsc strict（含 noUncheckedIndexedAccess）
npm test            # vitest：16 条（Core 语义 + Rise 解锁链 + 真实配置回归）
npm run check       # luaparse 语法校验 reframework/ 下全部 .lua
npm run build       # 生成 SDK 枚举 → 生成配置 → 打包 mhw_rogue.lua → 自动部署进游戏目录
npm run deploy      # 仅部署（自动探测游戏目录；内容相同则跳过）
npm run dev         # watch 模式（改完想部署再手动跑 npm run deploy）
```

## 安装（游戏）

`npm run build` 一条龙：构建后自动拷贝到游戏目录（探测顺序：命令行参数 >
`MHR_GAME_DIR` 环境变量 > Steam libraryfolders.vdf 扫描 > 默认安装路径）。
游戏运行中也允许部署：REFramework 监视 autorun 自动热重载；UI 没变就重启游戏。
手动安装：把 `reframework/autorun/mhw_rogue.lua` 放入游戏的同路径。任务 900101「斗技场肉鸽」会注册到
集会所/村庄 → 探索任务（FreeSide）列表，复用 free_arena 原型的注册机制；
若 free_arena.lua 同场运行，安装器会自动采纳其已注册的同名任务而不冲突。
热调数值：把 `data/rogue_config.json` 改名 `mhw_rogue_config.json`
放到游戏目录即可覆盖内嵌配置。运行时日志/报告在游戏的 `reframework` 目录。

## 现状（M1 启动与 HUD 已实机验证，关卡待验）

2026-10-23 已实机复现并修复配置字段大小写、Lua 缺少 Date、hook 回调签名与
新旧安装器兼容问题。游戏内手动 HUD 循环已推进至第 2 层，最终产物启动与任务采纳通过。
详见 [实机测试记录](docs/runtime-2026-10-23.md)。实际进出斗技场、运行时刷怪仍未验证。

- 已完成：Core 逻辑移植（16/16 测试）、任务安装器（采纳或安装）、ImGui HUD、
  配置热覆盖、三关验收（typecheck/test/check）全绿。
- 已知未解（沿自 free_arena 记录）：空斗技场会刷出一只 Arzuros，
  TOUR 任务运行时刷怪行为未定——M2 波次系统的第一道题。
- 未迁移：讨伐检测、动态刷怪、道具发放（M2+，需实机逆向）。

## 历史记录（free_arena 原型）

Quest 900101 appears under Village Quests > Free Exploration, registered by
`free_arena.lua` as a tour on arena map 10 with no time limit. On 2026-10-22
the player entered the quest and reported a bear (Arzuros, monster id 60 per
`.local/RiseQuestLoader/RiseQuestEditor/Assets/Monsters.json`) in the arena;
the cause is unconfirmed — `free_arena_check.lua` only verifies stored quest
data, not runtime spawns. `reframework/quests/q900101.json` is a research
artifact, not loaded at runtime.
