# T3 队列探针分析 — 2026-10-26 — 两个重大发现

数据源：rogue_inplace_queue_trace.json（M2a 场景，镰鼬龙王98→眠狗龙王54，
玩家按指引采集：出场等5秒→击杀→等第二只→击杀→保存轨迹）。
探针采样了 QuestManager/EnemyManager 的钩子计数 + 每秒的
bosses/RequestLoadInfo/EnemySetInfo 快照。

## 发现一（意外）：两只怪是"同时在场"，不是"死一只刷一只"

时间线（16:26 起）：
- 26:41 sets 初始化（12 条 EnemySetInfo，全部 SetStatus=0 InitWait）
- 26:42 load=3（模型预载请求）
- 26:43 SetStatus 0→2，首只 98(uid0) 出场
- **27:11 第二只 54(uid100) 出场——此时 98 还活着**
- 27:20 玩家击杀 98（98 先于 27:11 就活着的 54 晚了 9 秒死）
- 27:47 击杀 54

即：**第二只的入场是时间/流程驱动的自动入场（出场后约 30 秒），
与第一只的死活无关**。M2a 验收时的"杀一只出一只"体感是时序巧合
（玩家击杀恰好在自动入场之后）。推论：
1. 我们写的 `BossSetCondition=EM1_HP(7)`（1号死后出）**可能根本没生效**，
   引擎按自己的节奏（或模板 603 的原始条件）放了第二只进场；
2. "BOSSRUSH=顺序出怪"的机制理解需要修正：它是"多怪依次自动入场"，
   不是"死亡驱动的队列"。对肉鸽的影响：单怪波与双怪波的观感差异
   主要来自怪表条目数，而非我们控制的顺序逻辑。

## 发现二（T3 靶点命中）：战斗中存在可读可写的出怪队列

`EnemyManager._EnemySetInfoList`（12 条 EnemySetInfo）在战斗中全程
可枚举（探针每秒读到了完整字段），且是**普通托管对象**：

- 字段可写：`EmSetId`（怪种，Int16）、`EmGenId`、`SetStatus`、`UniqueID`…
- 方法可调：`updateSetStatus(status)`、`repop()`、`setupEnemy()`、
  `resetEnemy()`、`destroyEnemy(num, status)`；
- 生命周期实测：`0 InitWait → 2 Alive → 3 Dead/Dying → 4 End`，
  销毁标志 `DestroyStatus`（收尾时 set0/set1 → dst2）；
- 钩子计数证实这就是出怪入口：`createEnemyFromSetInfo` 4 次
  （两只 boss + 环境怪），而 `EnemySetInfo.repop()` 全场 **0 次**
  ——引擎自己没用过它，但方法就在那里（RepopNum/RepopMax 字段配套）。

推论：**战斗中改怪的正确入口不是 RawNormal（已证死），而是
EnemySetInfo：写 `EmSetId` → 推 `SetStatus` 回 InitWait（或调 `repop()`），
让引擎用新 ID 重新走 createEnemyFromSetInfo**。inPlace 以新形态复活。

## 未解问题（下一轮实验，一次一个变量）

1. `updateSetStatus(InitWait)` 或 `repop()` 之后，引擎是否按**新的
   EmSetId** 生成（生成时才解析 ID）？还是另有缓存？
2. 重新生成的怪会不会进目标计数（_TgtEmType/_QuestTargetEmDieUidList）？
   不进的话击杀它不推进结算——需要实测一个"repop 出来的怪能不能被
   正常讨伐计数"。
3. 死亡判定建议升级：bosses 快照自带 `dying` 标志，比 UID 列表轮询更直接。

## 对策

- reentry 主路线不变（已验证）；
- inPlace 复活课题 T3 从"寻找入口"升级为"验证 repop/换 ID 出怪"，
  实验设计：M2a 场景杀第一只后（第二只活着时），把 set1 的 EmSetId
  从 54 改成 44（泥鱼龙），观察后续生成的是不是新怪、能否正常讨伐计数。
