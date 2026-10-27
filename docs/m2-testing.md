## 2026-10-27 当前默认与验收边界

默认路线改为 **inPlace**；`reentry` 保留手动选择与自动失败回退。普通层选项固定为 Single / Sequential / Simultaneous，选项自己的模式覆盖旧全局 SpawnMode。极强怪池仍限单怪。

最新日志：顺序双怪同场清波和波次间购买已成功；同时双怪在初次进任务时成功，但同场续波曾只出第一只并超时回退。续波基础HP倍率也有明显偏低现象，尚未修复。默认 inPlace 不代表这些问题已通过验收。

## 2026-10-24 实机修复与测试按钮

部署文件后必须在 REFramework → ScriptRunner 点 **Reset scripts** 才会重新执行脚本；单纯复制文件不会自动重载。请在村庄重载，重载会结束脚本侧当前局的跟踪状态。

面板最上方新增：
- **Invincible: OFF/ON**：点击切换无敌。仅对单人自定义斗技场任务 900101、900102 生效；默认关闭，脚本重载关闭。
- **Kill all spawned bosses now**：对点击时已经出现的大型怪物请求原生致死伤害；后续新刷出的怪物需要再点一次。原生死亡动画、讨伐计数和任务结算仍由游戏执行。

已实机确认自动接取按钮能够出发进入斗技场；首次故障是原生接任务动作漏调 `.ctor`，补上后进入成功。加载过程中村庄管理器销毁属于正常状态，出发等待阶段已修正。怪物 HP 的 DeviceContext 只能在原生怪物 update 上下文读取，改为钩子采样、普通帧读取快照；击杀使用 `stockDirectForceKillDamage`，已看到原生 1/2 计数及两目标完成。

本轮后续实机已确认能从村庄自动出发并进入脚本 `Combat`，观测到目标 98 和 54。完整跟踪时暴露了死亡确认滞后的问题，末次修复切到 `QuestManager.questEnemyDie(enemy, endType)`，并轮询 `_QuestTargetEmDieUidList.Contains(uid)` 兜底（按真实 UID，不用空列表推断死亡）。这笔末次修复已通过离线回归、构建并部署，尚未完成实机复验：文件选择对话框使电脑控制工具报 `failed to activate captured window`，已请求用户取消该框。无敌开关已在实机安装、启用，但尚未做实际受击验证。

伤害暂沿用 603 模板的原生基础难度，面板 ATK x1 是相对倍率，开荒装备测试建议启用无敌。

# M2 交付与玩家验收

本次只做离线实现与验证，没有启动、操作或关闭游戏，也没有把开发产物热写入运行中的游戏。
TypeScript 测试、类型检查、Lua 语法检查及真实 Lua 5.4 的编译产物检查覆盖软件逻辑；
下面的原生引擎行为仍由实机决定。先 M2a，再验证完整肉鸽循环。

## 开始测试

1. 关闭 Rise，运行 `npm run build` 构建并部署；或手动复制 `reframework/autorun/mhw_rogue.lua`。
2. 如已有覆盖配置，更新其中的 `Quest` 为 `Id=900102, BaseId=603, MapNo=10`。
   旧 900101 / 101 的 TOUR 配置不能用作 BOSSRUSH 模板。
3. 用原有角色进入村庄，不承接其他任务。打开 REFramework → Script Generated UI →
   **MHR Arena Roguelike - M2**，等待 `Native hooks ready (solo)`。
4. 模组仍使用角色当前装备。Bone/Iron 选择仅为 Core 中的开局选项，不会给角色换装备。

## M2a：原生顺序出场

点击 **M2a: test 2 native sequential monsters (0 PT)**。脚本准备 900102，并尝试原生柜台接取、出发。
目标为 Great Izuchi / Great Baggi，奖励固定 0 PT。出生配置是：

| 槽位 | 怪物 | BossSetCondition | BossSetParam |
|---|---|---|---|
| 0 | Great Izuchi（98） | DEFAULT（1） | 0 |
| 1 | Great Baggi（54） | EM1_HP（7） | 0 |
| 2–6 | None（0） | NONE（0） | 0 |

杀第一只后观察第二只是否在 10 秒内正常出现并战斗。出现两只重叠、始终不出、模型存在但不能战斗，
都应分别记录；不要只根据“任务注册成功”判定通过。轮询默认每秒一次，日志时延为采样时延。
两个目标都被实际猎杀/捕获后才进入剥取阶段，空列表和出场间隙都不会算通过。

测试不自动把 go/no-go 判定改成“通过”。若出场超时，M2a 保留 Fault 与日志，
不会偷偷改为同时出场使该测试看起来成功。可停止本局、原生返回后再测。

## M2b/M2c：实际循环

M2a 完成返回村庄后，点击任意 **Start run**。首层有三个候选，低层只有 A/B 类型时会重复抽取类型，
而不是少显示一个候选。选择后是原生任务怪表，不存在脚本手动创建 Enemy 的路径。

核验流程：

1. 选项对应怪物实际出现；HP/ATK hook 对这些目标生效，未改原版表索引。
2. 杀一只双怪目标时不发整波 PT；第二只死亡或捕获后只发一次奖励。
3. 成功结算暂时被压住，可剥取。默认等待 20 秒后，回到入场时捕获的起始位置 15 距离单位内，
   连续停留 2 秒；缺失的入场玩家不会被当成已集结。
4. 默认 `inPlace` 路线在集结后同场显示下一层三个选项；未出怪超时则回退 `reentry`。
   PT、猫车与 Core 解锁记录仍在，而原生本任务死亡计数重新开始。
5. 猫车耗尽或原生任务失败时，本局终止并释放结算拦截。停止按钮只作用于本模组任务。
6. 进入别的任务、离开任务、发生联网或能力读取错误时暂停为 Fault，不给未完成波次发 PT。

当前默认池以地图 10 模板证据为准。原 Gaismagorm 解锁规则仍保留作研究数据，
但 Gaismagorm 等未有地图 10 证据的目标不进入默认池；不宣称该解锁链已在本版实机跑通。
Core 的相应解锁逻辑仍有独立测试。

## 路线及降级

| 设置/事件 | 行为 |
|---|---|
| `Route=reentry` | 每层重新进入原生任务；作为手动路线与自动失败回退 |
| `Route=inPlace`（默认） | 同场注册新原生记录，复用空闲任务槽与顺序游标，再走原生加载生成 |
| 旧 RawNormal 热改实验 | 该旧实现失败，不等于现有原生队列续波不可行；详见最新 inPlace 研究与证据 |
| 普通顺序波次未能全部出场 | 重进并把本波条件改为全部 DEFAULT；仍失败就 Fault，避免无限重试 |
| M2a 的顺序测试失败 | 只报告失败，不做“改条件后算测试通过” |

未调用 `setupQuest_CreateEnemy`、prefab instantiate 或其他生成管线 API。
同场改 RawNormal 不会重置引擎内部怪物/目标计数，因此这是实验分支；默认重进让引擎自己重新初始化。

## 原生柜台失败时

自动柜台有 45 秒超时，会记录具体阶段，并区分 routine.isExecute 与 routine.execute 的异常。
超时/取消会先关掉输入和确认 hook 的谓词，再清理其打开的柜台。
确认返回值使用当前 dump 的 `GuiManager.YNInfoResult.Yes=0`，没有混用窗口状态的 `Yes_on=1`。

如果已经承接了任务，请先在游戏里取消/返回；然后使用 **Retry native post**。
也可以复制完整配置到 `reframework/data/mhw_rogue_config.json`，将 `Runtime.AutoPost` 改为 `false` 后重载脚本。
重新选好波次后，从**村庄 → 探索任务**手动接受 **Arena Roguelike / 斗技场肉鸽（900102）**。
旧 Free Arena（900101）不是本版战斗任务。手动承接路径的具体 UI 可达性也需本次实机确认。

不要在进行中的肉鸽局热重载；脚本不保存/恢复本局状态。若重载后仍在该任务中，先原生返回村庄再开新局。

## 配置

`reframework/data/mhw_rogue_config.json` 是完整配置覆盖，不能只写一个 Runtime 片段。
无覆盖文件就用内嵌默认值，字段大小写沿用原 JSON；类型/范围校验失败会回退默认配置。

```json
"Runtime": {
  "Route": "inPlace",
  "SpawnMode": "sequential",
  "AutoPost": true,
  "PollSeconds": 1,
  "SpawnTimeoutSeconds": 90,
  "CarveSeconds": 20,
  "CampRadius": 15,
  "CampDwellSeconds": 2,
  "PostTimeoutSeconds": 45
}
```

距离是引擎坐标单位，先观察默认半径是否适合实际出生点，再调整。
`SpawnMode=simultaneous` 使用 DEFAULT 让本波目标一起出场；M2a 按钮始终测试顺序模式。
计时采用 Lua `os.time` 墙钟而不是进程 CPU 时间，最小采样精度为秒。

## 需要提供的证据

游戏的 `reframework/data/`：

| 文件 | 用途 |
|---|---|
| `mhw_rogue_boot.json` | 脚本入口、任务 ID、路线 |
| `mhw_rogue_install.json` | 安装计划、怪物 ID、克隆模板；不证明出发/出场 |
| `mhw_rogue_runtime.json` | 最近 100 个状态事件及原生观测 |
| `mhw_rogue_spawn_evidence.json` | 顺序出场采样时延、重叠出场、实际清波事件 |
| `mhw_rogue_runtime_error.json` | 最近一次流程/能力故障，可能来自旧会话，必须对时间 |
| `mhw_rogue_error.json` | 入口异常，可能来自旧会话，必须对时间 |

同时记录 `re2_framework_log.txt`、第一只死亡/第二只出现的视频或时间、是否有非目标熊、
是否能剥取及原生返回。不要用旧 JSON 文件的存在证明当前运行成功。

## 数据与 API 依据

- [bossrush_reference.json](../data/bossrush_reference.json)：603/101 完整快照、字段差异、14 个样本摘要。
  603 的 `[1,7,12] / [0,65,50]` 是 HP 阈值出场；BOSSRUSH 位标志本身不等于逐只讨伐。
  样本 60133 有重复怪物 ID 59，并非所有任务都由不同怪物组成。
- [sdk.create_managed_array](https://cursey.github.io/reframework-book/api/sdk.html)：按原生元素类型复制数组。
- [REManagedObject 引用和调用](https://cursey.github.io/reframework-book/api/types/REManagedObject.html)：
  新建对象保持引用，发布替换后平衡释放自己持有的引用；不会 force_release 游戏对象。
- [SystemArray](https://cursey.github.io/reframework-book/api/types/SystemArray.html)：原生数组以 0 为起点；
  没有用 TS/Lua 的 1 起点数组遍历代替原生 Get/Set 索引。
- [JSON 路径](https://cursey.github.io/reframework-book/api/json.html)：配置和报告均相对 `reframework/data`。

不把 MHW 的接口、偏移或名称带入 Rise。任务柜台实现只参考本地 AutoQuest 中的引擎 API 用法，
采用独立的有限状态机，没有引入其源码模块或未经许可的代码。
