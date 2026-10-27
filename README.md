# MHR Arena Roguelike — M2

Monster Hunter Rise 16.0.2.0 / REFramework v1.5.9.1 的斗技场肉鸽研究模组。
TypeScript 经 TypeScriptToLua 编译为单文件 `reframework/autorun/mhw_rogue.lua`。

**M2a/M2b/M2c 的实现和离线验证已完成，游戏内验收由玩家执行。**
当前实现为单人模式；原生连刷、自动柜台、计时/结算拦截和倍率 hook 都仍需实机确认。
默认使用 inPlace 同场续波，失败自动回退 reentry。顺序波次已实测；同场同时双怪仍有第二只未出场的问题。

## 实现内容

- **M2a**：从原生 BOSSRUSH 603 深克隆任务 900102，独立复制全部怪槽数组；提供
  Great Izuchi → Great Baggi 的零 PT 连刷测试。任务位于村庄探索列表，旧 900101 原型保持独立。
- **M2b**：观察原生怪物列表及死亡/捕获事件；按唯一 ID 和目标数量去重，空场不会结算。
  本模组准备的任务才启用计时与成功结算拦截；HP/攻击倍率作用于难度倍率返回值，
  不把 `_VitalTbl` / `_AttackTbl` 的表索引当成数值倍率。
- **M2c**：三选一 → 写怪表 → 原生接取/出发 → 真实击杀发 PT → 剥取 → 回起始点集结
  → 同场下一层；异常时退回原生重进流程。PT、全局猫车数、解锁状态跨任务保留。
- 原生柜台超时/取消会释放输入与确认 hook；可以关闭自动接取、手动承接已准备好的任务。
- 同场热换失败会退回重进；顺序出场失败可改为原生 DEFAULT 同时出场重试，均不会凭空发 PT。

详细操作、配置、日志、失败恢复及实机验收表见 **[M2 测试说明](docs/m2-testing.md)**。

## 构建与安装

```bash
npm ci
npm run typecheck
npm test
npm run build:nocopy   # 生成 SDK、配置与 Lua；不写入游戏目录
npm run check
python -m pip install lupa
npm run check:runtime # 在真正的 Lua 5.4 中离线执行编译产物
```

关闭游戏后执行 `npm run build`，会构建并部署到自动探测的 Rise 目录。
也可将产物手动复制至游戏 `reframework/autorun/mhw_rogue.lua`。
不依赖热重载保留进行中的肉鸽状态；重启/重载脚本后从新局开始。

覆盖配置：把**完整的** `data/rogue_config.json` 复制到游戏
`reframework/data/mhw_rogue_config.json`，修改后重新加载脚本。缺字段或非法值会回退到内嵌配置。
配置不是放在游戏根目录，参见 [REFramework JSON API](https://cursey.github.io/reframework-book/api/json.html)。

## 默认路线与证据边界

`data/bossrush_reference.json` 保留了实际模板 603/101 的字段及差异、本地 14 个 BOSSRUSH
样本摘要和地图 10 的怪物 ID 集。快照含 78 个原版任务；加上旧原型后为 79 个。
603 的条件实际是 `[DEFAULT, EM1_HP, HP_EMx1]`、参数 `[0,65,50]`，不是天然的逐只讨伐出场。
M2a 显式测试 `EM1_HP=0`，其引擎时序必须实机核验。

默认池只使用地图 10 原生模板出现过的怪物，且修正 Valstrax 的名称映射。
原始实验池另存于 `data/unverified_monster_pools.json`，不自动加载。
地图出现证据不等于新组合、初始点、初始化参数全部可用；也不能据此宣称熊问题已消失。

联网状态同步、真正切换初始装备、商店及道具下发属于后续工作；当前不冒充已实现。
猫车/剥取/集结与怪物死亡事件负责推进流程，HUD 不再提供模拟清怪或跳层按钮。

## 代码结构

| 路径 | 职责 |
|---|---|
| `src/core/run_core.ts` | PT、三选一、倍率、商店模型和一局状态 |
| `src/core/run_session.ts` | 真实事件驱动、集结、重进、去重、失败与降级 |
| `src/core/quest_plan.ts` | 名称→ID、怪表及目标条件的纯数据计划 |
| `src/game/quest_installer.ts` | 独立数组克隆、事务式发布、原生菜单/文本 |
| `src/game/native_runtime.ts` | 观测、作用域隔离、计时/结算/倍率 hook |
| `src/game/quest_transport.ts` | 原生柜台、单人选择、确认、出发、超时清理 |
| `src/game/sdk.ts` | 唯一宿主 API 声明入口 |
| `sdk-dump/` / `scripts/gen-*.js` | 固定版本 RTTI、SDK 类型/枚举生成 |

SDK 普通访问拒绝错误字段/参数；已核对但 dump 不完整的动态调用使用显式边界。
历史材料：[迁移方案](docs/migration.md)、[M1 实机记录](docs/runtime-2026-10-23.md)、
[原生刷怪/UI 调研](docs/research-spawn-and-ui.md)。历史“已通过”不代表本版 M2 已实机通过。

### 测试用战斗按钮（2026-10-24）

`MHR Arena Roguelike - M2` 面板顶部可切换 **Invincible: OFF/ON**，或点 **Kill all spawned bosses now** 对当前已刷出的大型怪物施加原生致死伤害。仅限单人 900101/900102；无敌默认关闭，重载也会关闭。模板 603 的基础攻击力仍然保留，开荒角色可开启无敌做流程验证。实机验证范围及最新限制见 [M2 测试说明](docs/m2-testing.md)。

游戏运行时复制脚本后，到 `REFramework → ScriptRunner → Reset scripts` 手动重载；单纯覆盖 autorun 文件不会自动重新执行。建议回村后重载。
