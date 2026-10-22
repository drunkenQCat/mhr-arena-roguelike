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

## 命令

```bash
npm ci
npm run typecheck   # tsc strict（含 noUncheckedIndexedAccess）
npm test            # vitest：14 条（xUnit 11 条语义移植 + Rise 新增）
npm run check       # luaparse 语法校验 reframework/ 下全部 .lua
npm run build       # 生成 src/game/default_config.ts 并打包 mhw_rogue.lua
```

## 安装（游戏）

关闭游戏后，把 `reframework/autorun/mhw_rogue.lua` 放入游戏的
`reframework/autorun/`。任务 900101「斗技场肉鸽」会注册到
集会所/村庄 → 探索任务（FreeSide）列表，复用 free_arena 原型的注册机制；
若 free_arena.lua 同场运行，安装器会自动采纳其已注册的同名任务而不冲突。
热调数值：把 `data/rogue_config.json` 改名 `mhw_rogue_config.json`
放到游戏目录即可覆盖内嵌配置。运行时日志/报告在游戏的 `reframework` 目录。

## 现状（M1 移植完成，待实机验证）

- 已完成：Core 逻辑移植（14/14 测试）、任务安装器（采纳或安装）、ImGui HUD、
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
