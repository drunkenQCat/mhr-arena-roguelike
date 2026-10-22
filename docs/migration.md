# MHW Roguelike → MHRise (REFramework TypeScript) 迁移方案

> 2026-10-22 定案：项目从 MHW (SPL/C#) 迁移到 Monster Hunter Rise (REFramework/Lua)。
> 脚本以 TypeScript 编写，经 TypeScriptToLua (TSTL) 编译为 Lua——有类型防护的形态，
> 编译期拦截大多数"跑在游戏里才发现"的错误。

## 1. 调研结论

### 1.1 已有可复用资产（本仓库）

| 资产 | 状态 | 迁移用法 |
|---|---|---|
| `reframework/autorun/free_arena.lua` | **已跑通**：900101 注册、任务柜可见、可进入 | 移植为 `src/game/quest_installer.ts`（改为"采纳或安装"语义，兼容共存） |
| `.local/autoquest-study/AutoQuest` | 研究用参考模组（无 LICENSE，不抄代码，只验证 API 用法） | 证实 `imgui.*` snake_case API、`re.on_draw_ui` 树节点窗口模式 |
| `.local/RiseQuestLoader/.../Monsters.json` | Rise 大型怪 ID 表（117 项） | 导出为 `data/monster_ids.json`，怪物池用名字、游戏层用 ID |
| `.local/arena_catalog.json` | 79 个任务模板快照 | M2 生成任务时参考 |

已知未解问题：空斗技场会出现一只 Arzuros（熊）——TOUR 任务的运行时刷怪行为，
M2 波次系统必须先解决/利用它（README 有记录）。

### 1.2 TypeScriptToLua 生态（调研）

- [TypeScriptToLua](https://github.com/TypeScriptToLua/TypeScriptToLua)（npm `typescript-to-lua` 1.37.1）：
  成熟的 TS→Lua 转译器，支持 `luaTarget 5.4`（REFramework 即 Lua 5.4）、单文件打包
  （`luaBundle`）、strict TS、源码级 source map。
- [lua-types](https://github.com/TypeScriptToLua/lua-types)：Lua 标准库的 `.d.ts`。
- RE Engine 社区已有先例：[Zugfritze/MonsterHunterRiseMod](https://github.com/Zugfritze/MonsterHunterRiseMod)
  ——MHRise 模组用 TSTL 编写，结构为 `src/*.ts` + `types/{sdk,re,imgui,json,log}.d.ts`
  （手写声明）+ 打包成单个 lua。**没有现成的 REFramework 类型声明包**（npm/GitHub 均无），
  该仓库亦无 LICENSE，故本仓库的 `types/` 依 [REFramework 官方文档](https://cursey.github.io/reframework-book)
  与本仓库已验证的 `free_arena.lua` 用法自行编写，不复制其代码。

### 1.3 迁移映射（C# → TypeScript）

| MHW 侧（mhw-moddev 仓库） | 本仓库目标 | 说明 |
|---|---|---|
| `MhwRogue.Core/Config.cs` | `src/core/config.ts` | 配置模型 + 校验；数值仍外置 JSON |
| `MhwRogue.Core/RunState.cs` | `src/core/run_state.ts` | 一局状态 DTO；record→interface |
| `MhwRogue.Core/RunCore.cs` | `src/core/run_core.ts` | 状态机/商店/抽卡/公式 1:1 移植 |
| `System.Random`（种子） | `src/core/rng.ts` | mulberry32 可播种 RNG（联机确定性前提） |
| `MhwRogue.Tests`（xUnit 11 条） | `src/core/*.test.ts`（vitest） | 语义等价移植 + 新增解锁链/架构守卫测试 |
| `MhwRogue/Platform/GameApi.cs` | `src/game/sdk.ts` | Platform 纪律保留：全局 API 只在一个文件出现 |
| `MhwRogue/Ui/Hud.cs`（ImGui） | `src/game/hud.ts` | `re.on_draw_ui` + `imgui.*` |
| SPL 插件装配 / TestRunner | `src/game/main.ts` + 安装器 | autorun 入口；场景测试框架后置到 M2 |
| `data/rogue_config.json` | `data/rogue_config.json` | 结构不变；怪物池换 Rise 阵容；解锁链数据化 |
| （MHW 特有）EntryQuestIds | 删除 | 入口任务 = 安装器注册的 900101（配置 `quest` 段） |
| （C# 硬编码）煌黑→黑龙解锁 | `unlockChain` 数据 | Rise 对应：讨伐爵银龙 → 解锁冥渊龙 |

### 1.4 分层与纪律（延续 C# 架构）

```
src/core/   纯逻辑：不 import 任何游戏全局（sdk/re/imgui/json/log）。
            vitest 直接在 node 跑；tsc 严格模式；守卫测试防越界。
src/game/   REFramework 交互层：sdk.ts 声明并导出类型化封装（全局仅在
            此文件 declare），quest_installer / hud / main。
types/      REFramework Lua API 的手写 .d.ts（@noSelf 声明全局）。
data/       数值唯一真源：rogue_config.json（构建期内嵌为默认配置，
            运行时优先读游戏目录同名文件以便热调）。
构建：       npm run build → TSTL 打包单文件 reframework/autorun/mhw_rogue.lua
            （产物入库，mod 分发即拷贝 reframework/ 目录）。
验收三关：   npm run typecheck（tsc strict）→ npm test（vitest）→
            npm run check（luaparse 语法校验产物）。
```

### 1.5 明确不做（本期范围）

- 波次刷怪/讨伐检测（M2 spike：需先解决"熊"问题，确认 TOUR 任务的运行时刷怪机制）；
- SimServer/sim.html 保留在 mhw-moddev（C# 快照冻结为历史参考，不再演进）；
- 联机同步（M6）。
