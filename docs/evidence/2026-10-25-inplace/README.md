# inPlace 路线实机否定 — 2026-10-25

玩家实测（route=inPlace）：第 1 层正常（reentry 语义）→ 回原点后 inPlace 正常弹出第 2 层三选一
（Kulu-Ya-Ku + Tetranadon，hpMul 0.56 已算好）→ 选择后**引擎沉默**：不刷怪、不结算、无超时自愈。
最终由玩家手动触发结算/重置收场。

## 事件流（拷贝自 <game>/reframework/data/）

19:25:46 camp-gathered(token 6)
19:26:06 wave-published {experimentalInPlace: true, monsterIds: [107,92], token 7}
19:26:40 runtime-error "Native settlement began unexpectedly; no automatic next wave"

## 玩家关键修正（定性依据）

错误信息里的"原生结算开始"并未发生——引擎实际是**沉默无视**（不刷怪、不结算、不超时），
19:26:40 的 runtime-error 是观测层把"改写后的空闲态"误判成结算（误报 bug，另立修复项）。

## 结论

1. 引擎的任务怪表只在任务初始化（出发/重进）时读取一次；战斗中改写 RawNormal 无读取时机。
   inPlace 无条件死刑——连"重置计数器"这类半吊子修复都没有意义（数据通道整体关闭）。
2. reentry（每层重进、引擎重新初始化）是唯一可行路线，已实机验证（M2a + 完整循环）。
3. 误报 bug：结算探测谓词在 inPlace 场景误触发。修复方向：谓词须同时校验
   "任务处于 play 状态 且 存在存活目标"，禁止单字段匹配。
4. m2-testing.md 原预测"同场改表后没有新目标→超时后自动重进重试"与实测不符：
   实际无超时自愈，需玩家手动重置。已修正该文档。
