# inPlace 复活课题：消除每层加载屏（backlog，低强度并行研究）

> 2026-10-25 立项。动机：reentry 路线每层一次结算+加载（约 10~20 秒），
> 20 层的局累计 3~7 分钟纯等待。玩家明确要求保留这个研究口子。

## 已定边界（实机证据，不再重复验证）

- **已测实现：战斗中仅改写 RawNormal 怪表没有触发下一层刷怪**，没有观察到结算或超时恢复
  （docs/evidence/2026-10-25-inplace/，cb3f350）。这否定该实现，不能据此证明所有任务数据只读取一次。
- 研究焦点是**运行时出怪队列**。修改加载前数据只能优化 reentry，不能消除加载。

## 三个靶点

### T1：怪表快照的精确时点
引擎读怪表的那一刻在哪？候选：接取确认时 / Loading 前半段（大厅侧）/ Loading 后半段（场景侧）。
- 若在 Loading 前半段：**出发前最后一刻改表**可生效 → 下一层的怪可以在回村前写好，
  减少重进流程中的等待操作；它仍然需要回村/加载，不是无加载的 inPlace。
- 若在前半段之前（如接取确认时）：关闭这项时序优化，不能据此关闭 T3。
- 探测法：在各时点 hook（makeQuestNoList 同族）+ 改表，二分定位读取窗口。

### T2：结算演出的可压缩性
reentry 的层间成本 = 原生结算演出（数秒）+ 任务加载（硬成本）。
- 研究结算确认 hook 后能否**立即发起重新接取**（不等结算画面走完），把演出时间吃掉。
- 收益即使只有 3~5 秒/层，20 层也省 1~2 分钟，且实现风险低（纯时序，不碰数据）。
- 可能与 T1 冲突（若演出期间就是快照窗口，压缩=抢改表时间），需一起测。

### T3：连战任务的运行时队列 —— 已观测，复用尚未验证（2026-10-26 更正）
只读探针捕获 `_EnemySetInfoList` 生命周期 InitWait→Alive→Dead→End，
以及 QuestManager._BossSet 的激活/释放变化。详见 docs/evidence/2026-10-26-t3-queue/。
玩家确认死一个才放下一个；16:27:11 第二只出现时，第一只原生讨伐计数已为 1，
死亡 UID 列表已包含第一只。dying 晚约 9 秒才置位，不能当作死亡发生时间。
撤回“30 秒自动入场、EM1_HP 疑似失效”以及“以 dying 替代 UID 判定”的结论。
`EmSetId` 是出怪记录编号（0、1），怪物类型是 EmType（98、54）；不能将 54/44 写入 EmSetId 换怪。
反射有 repop/updateSetStatus 等方法不代表已验证可用；只读探针未验证任何写入或复活。
下一步补齐 BossSetParam 的父类字段，再在已清理条目上单独验证同怪种 repop；
换怪、重设状态和目标计数分别研究，不与第一次复用试验同时修改。

## 判定与退出

- T1 结论为"接取确认时读" → T1 关闭；T2 独立继续。
- T3 若发现可写波次块 → inPlace 复活为新路线，重新评估。
- 全部关闭 → 本课题归档，加载屏成本接受为引擎约束。

## 强制规则

- 每次实机验证附带在正常循环跑动中（不占专门档期），一次只观察一个现象；
- 任何"有效果"的观察必须可复现两次才入档（防单次环境噪声）；
- 结论无论正负都更新本文件并链接证据目录。

## 2026-10-25 代码接手：T3 已找到具体对象，尚未实测

当前 SDK `sdk-dump/sdk_types.json` 有独立运行时结构：

- QuestManager：`_BossSet: QuestEmSetParam[]`、`_BossSetCond`、`_BossSetNoTbl`、
  `_BossSetCount`、`_BossLoadStartOk`、`_BossLoadDone`；方法
  `getBossSetInfo(slot)`、`checkNextEnemyAppearCondition()`、`get_NextBossSetNo()`。
- EnemyManager：`_EnemySetInfoList`、`_RequestLoadEnemyList`。
- EnemySetInfo：`EnemySetParam`、`SetStatus`、`DestroyStatus`、`WaitSecond`、`EmSetId`、
  `EmGenId`、`UniqueId`，以及 `repop()`、`resetEnemy()`。方法存在不代表可以安全独立调用。
- 当前枚举：EnemySetStatus 为 InitWait=0 / ReviveWait=1 / Alive=2 / Dead=3 / End=4；
  QuestEmSetState 为 None=0 / Set=1 / Release=2。
- 较旧 RSZ 提供字段线索：QuestEmSetParam 的 EmSetId/EmType/State/Param0/Param1；
  EnemySetParam 的 _TypeValue/_SetPos/_SetRot/_BlockNo 等。必须由当前运行时反射复核，禁止照旧布局写偏移。

**要验证的方案**：在原生连战还有待出怪槽时，门控下一只的出现条件；回营选完下一层后，
更新该槽真正持有的 EnemySetParam，恢复条件，让引擎消费原有队列。队列耗尽后能否通过
`repop()` 回收一个原生槽，是第二个独立实验。前者有效也不等于支持无限层数。
需同时确认预加载怪种、目标计数、尸体/UID 清理和结算条件，不能只见怪物模型出现就算通过。

新增 `reframework/autorun-probe/inplace_queue_probe.lua`：只在单人 900102 记录上述字段，
每秒采样、最多 180 份，导出遇到的类型和相关方法调用次数。无写字段、刷怪或重置计数器操作。
输出 `reframework/data/rogue_inplace_queue_trace.json`。正常 M2a 连战中分别保留首只存活、
首只死亡到第二只生成、全部死亡后三段记录，找到真正变化的槽和状态，再设计一次最小写入实验。
JSON 序列化接口依据 [REFramework 官方文档](https://cursey.github.io/reframework-book/api/json.html)。

本轮实机受阻：Rise 未运行，Computer Use 的 native pipe 连接失败，重试及重置后仍失败。
探针已准备并复制到 autorun，未声称已运行。恢复测试后应将原始 trace 归档至 evidence 目录。

代码同时修复了观测层的一个分支：仅凭 `isPlayQuest=false` 不再将未出怪的 inPlace 等待
直接叫作“结算”；同一任务 ready 且尚未观察到新怪时允许走既有超时回退。
显式 success/return 仍停止追踪。本轮只有离线状态机验证，原生回退能否完成仍待实机。

## 2026-10-26 实机 repop 对照结果

已重启游戏恢复面板，开启启动时显示菜单；不再依赖失效的 Insert，后续均由 agent 操作。

- 已清理的首领槽直接 repop：原生空指针异常。异常指令与 OwnerEnemy 字段偏移匹配，尸体清理后 OwnerEnemy 已空。
- Dead 且 OwnerEnemy 尚存时 repop：正常返回，但槽变为 End，未增加生成次数、未出现新 UID；不是可用的首领复活。
- 已清理槽调用 updateSetStatus(InitWait)：正常返回，SetStatus=0；437 秒后仍无新出怪，DestroyStatus 仍为 2，生成调用次数不变。单改 SetStatus 不足以恢复槽。
- 下一对照需区分 DestroyStatus 与已释放的 QuestManager._BossSet 门控；目前没有证明原地复活。

原始数据、探针版本、SHA256 与机器码证据见 [repop 实机记录](evidence/2026-10-26-repop/README.md)。这些结果只否定相应调用形态，不能宣布整个 T3 不可行。


## 2026-10-27：原生代码纠正研究方向

已只读核对当前进程元数据、18 个原生函数和运行现场。updateEnemySetInfoQuestHost 遍历 _ZakoSetInfoList，不是首领列表；此前 enableRevival=true 不能推导首领可复活。首领由 QuestManager.updateBossEnemy → updateExtraEnemyCommon 调度，当前 _ExtraEmRno=End、_BossSetCount=2、后续顺序项=-1。第一只首领参数的 RepopMax 虚函数实际返回 0。详见[原生代码证据](evidence/2026-10-27-native-flow/README.md)。停止猜状态，先追踪正常首领加载/创建的完整调度链。


## 2026-10-27：不同怪种与释放槽复用实测通过

同一任务 unique 1994278460 中，使用独立 BossSetParam 注册青熊兽（type60），先在未用任务槽3生成 UID11700，随后在已释放任务槽2生成 UID11800。均经原生 RequestLoad 调度，无地图加载。青熊兽可被原生致死伤害讨伐、清理；非原目标怪未加入目标死亡 UID 列表，正式波次不能依赖该列表覆盖所有怪。仍保留原眠狗龙王，尚未验证全灭续波或无限循环。详见 [原始证据](evidence/2026-10-27-species/README.md)。


## 2026-10-27：全灭后续波与游标回收通过

拦截原生成功结算后，原目标全清、全部尸体清理，仍保持任务进行；用槽2和顺序索引2连续两轮生成青熊兽UID11900、12000。questEnemyDie对非原目标也触发，可作为通用死亡事件。EnemySetInfo仍追加、未回收，不宣称无限循环。见[证据](evidence/2026-10-27-cycle/README.md)。正式实验分支已接入InplaceWaves，默认reentry保持，等待实际状态机验收。
