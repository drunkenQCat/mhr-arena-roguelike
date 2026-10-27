# T3 队列探针分析 — 2026-10-26 — 已纠正死亡时序与字段含义

数据源：rogue_inplace_queue_trace.json（M2a 场景，镰鼬龙王98→眠狗龙王54，
玩家按指引采集：出场等5秒→击杀→等第二只→击杀→保存轨迹）。
探针采样了 QuestManager/EnemyManager 的钩子计数 + 每秒的
bosses/RequestLoadInfo/EnemySetInfo 快照。
配套 `mhw_rogue_runtime.json` 已归档，quest unique=-58860370 与轨迹一致，
包含 test-kill 请求及 monster-observed/wave-cleared 事件，供交叉核对。

## 更正：第二只出场时，第一只已经被原生计数为讨伐

时间线（16:26 起）：
- 26:41 sets 初始化（探针最多展示前 12 条，并非队列总数；前两条 InitWait，其余展示条目有 End）
- 26:42 load=3（模型预载请求）
- 26:43 SetStatus 0→2，首只 98(uid0) 出场
- 27:10 runtime 的 test-kill 记录 uid0 的原生致死伤害请求
- **27:11 第二只 54(uid100) 出场；98 的 QuestTargetData.Count 已为 1，死亡 UID 列表已含 0**
- 27:20 98 的 dying 才变为 true。这是死亡行为标志的变化，不是玩家击杀时间
- 27:37 runtime 的 test-kill 请求击杀 uid100
- 27:38 54 的讨伐计数变为 1，死亡 UID 列表含 0、100；RunSession 记录 wave-cleared
- 27:47 54 的 dying 才变为 true，同样晚于原生讨伐计数约 9 秒

玩家明确确认“死一个才放下一个”。本轮原生计数及 runtime 日志与该观察一致。
此前“约 30 秒自动入场、与第一只死活无关”的结论撤回：它混淆了死亡行为、
讨伐计数和对象仍留在列表中三件事。对象同时存在并不等于两只怪同时存活。
本次没有测到精确 HP 阈值，不能据此断言 EM1_HP 失效，也不能将单任务条件推广到所有 BOSSRUSH。

## T3 收获：战斗中存在可观测的运行时出怪记录；写入和复用尚未验证

`EnemyManager._EnemySetInfoList` 在战斗中可枚举；探针截取前 12 条。
当前反射只读取对象本层字段，BossSetParam 的父类字段尚未完整导出：

- `EmSetId` 是出怪记录编号（本次两只 boss 为 0、1），**不是怪物类型**。
  QuestManager._BossSet 中 EmType 才分别是 98、54；运行时参数另含 EnemySetParam。
- 反射存在 `updateSetStatus(status)`、`repop()`、`setupEnemy()`、
  `resetEnemy()`、`destroyEnemy(num, status)`；存在接口不等于已实测可安全调用。
- 生命周期实测：`0 InitWait → 2 Alive → 3 Dead/Dying → 4 End`，
  销毁标志 `DestroyStatus`（收尾时 set0/set1 → dst2）；
- 钩子计数 `createEnemyFromSetInfo` 为 4 次，但没有逐次参数记录，不能精确归因每次调用。
  `EnemySetInfo.repop()` 本轮记录 0 次；不能据此推断它适合复活 boss 或已具备无限续波能力。

研究假设：EnemySetInfo/EnemySetParam 值得继续验证。只读轨迹没有证明任意换怪、
状态复位或 repop 会生效，inPlace 仍未实现。禁止把怪物类型写入 EmSetId。

## 未解问题（下一轮实验，一次一个变量）

1. 先补齐 EnemySetParam 的父类字段，核对真正的怪种、位置和预载信息。
   最小主动实验应只复用已清理的同怪种条目，单独验证 repop，不同时换怪或修改状态。
2. 重新生成的怪会不会进目标计数（_TgtEmType/_QuestTargetEmDieUidList）？
   不进的话击杀它不推进结算——需要实测一个"repop 出来的怪能不能被
   正常讨伐计数"。
3. 保留原生死亡 UID 与讨伐计数；dying 仅作辅助证据。本轮它明显晚于原生计数，不能替代。

## 对策

- reentry 主路线不变（已验证）；
- 撤回“存活条目的 EmSetId 从 54 改为 44 再 repop”方案：字段含义错误，且同时改变多个变量。
- T3 下一步为补齐参数反射与已清理条目的同种复用实验；实验按钮尚未实现。

## 后续实机验证

2026-10-26 已完成三轮独立最小写入：清理后 repop 抛出 OwnerEnemy 空引用异常；尸体尚存时 repop 正常返回但变为 End；清理后仅恢复 InitWait 仍不出怪。具体原始数据与边界见 [repop 对照实验](../2026-10-26-repop/README.md)。T3 尚未验证原地复活，不能继续引用「入口已找到」作为成功结论。
