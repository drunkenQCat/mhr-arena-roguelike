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

### T3：连战任务（BOSSRUSH）的第二波数据块
M2a 已证明引擎在战斗中会"刷出下一只怪"——那么第二只怪的**出怪指令**在战斗中是可读的。
逆向：BOSSRUSH 刷第二只时读的是 RawNormal 还是独立的波次数据块（如 SpawnSet /
EnemyLot / 内部队列）？若是后者且可写，则找到了"战斗中可读的正确入口"，inPlace 以
新形态复活（改那个块而不是 RawNormal）。
- 探测法：M2a 场景下，杀第一只前后对 900102 相关对象做字段快照 diff。

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
