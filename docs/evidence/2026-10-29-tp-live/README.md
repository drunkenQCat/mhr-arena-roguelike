# TP 实机验证与机制定案（2026-10-29）

目标：收尾并行会话遗留的 tp 重构（未提交工作区），全程经 CLI（state/run/wait/test tp/game run-script）驱动，不手输 Lua。

## 调查链（四个死胡同 + 一个正解）

| 尝试 | 结果 |
| --- | --- |
| 敌人位置读 `_PosAfterMotionUpdate`（492342f 的原始假设） | ❌ 活体怪身上所有 `_Pos*` 字段/`get_Position`/`get_PositionWs` 全部 nil（em092 实证）→ **改用 `get_Pos()`**，返回可读的即时 vec3 |
| `sdk.create_instance("via.vec3")` + set_field 传参 | ⚠️ 实例读回正确，但经反射调用按值传参时 **invoke 成垃圾内存**（`_WarpPos` 读回 nan）——TS 的 `vec3()` 助手同样中招，测试 mock 无法暴露 |
| 玩家位置结构体 `set_field(<managed instance>)` | ☠️ **直接死锁游戏主循环**（心跳冻结、脚本回调永久卡住），强制重启恢复。此模式永久禁用 |
| 组件写入 `ref.x/y/z`（get_field 返回的引用） | ❌ 安全执行但位置不变（副本语义），且中途的写入实验因上一条的死锁污染了结论 |
| `player.setPosWarpConsiderDogRide(vec3)`（未提交代码的原方案） | ❌ 调用成功但不移动（vec3 垃圾 + 该方法本身在此状态不生效）；且其 `isAreaMove` 守卫在竞技场内恒为 true，永远拒绝 |

## 正解：游戏自己的 warp 流（引擎快速旅行路径）

```text
StageManager:setPlWarpInfo(Vector3f.new(x,y,z), 0.0, AreaMoveQuest.Normal=1)
StageManager:set_CurrentWarpFlow(0 /* WaitFadeOut */)
→ 引擎自动：淡出 → 移动 → 淡入（约 4s），期间 get_IsWarpFlowMoving()=true
```

`Vector3f.new` 是 sol2 usertype 的构造函数（TSTL 需以属性调用 `Vector3f.new(...)`，不能用 `new Vector3f(...)`——TSTL 会编译成自己的类协议 `____constructor` 而失败）。并发守卫从 isAreaMove 换成 `get_IsWarpFlowMoving()`。

## 实机结果（CLI 全程）

- `test tp --to monster`（无敌 ON）：玩家落到怪旁 (-7.4, -1.3, -34.5) vs 怪 (-3.7, -1.3, -29.8)，位置保持 ✓
- `test tp --to origin`：玩家回到营地精确坐标 (-0.0, 50.3, 46.9) ✓
- `run stop` 后两种 tp：均 rejected "TP requires an active solo arena run" ✓
- 无敌关闭状态下的两次 tp 也实际到达（随后被怪送回营地，nativeDeaths=2，猫车消耗 2——验证过程代价，无语病）
- 155/155 TS 测试 + typecheck + CLI 契约测试全绿

## 发现的已知空位（记录，未在本轮实现）

1. 结算画面（quest_ready）需要原生输入才能回村；孤儿任务（脚本重置后）会卡在该画面——任务书 `results.accept` 项。
2. tp 回执偶发 >15s 才落历史（warp 流淡出期间脚本节拍暂停所致）；CLI 客户端超时后可经 results 历史对账。
3. 观测面板敌人位置此前一直是空——本轮 `get_Pos` 修复同时让 state.enemies[].position 首次有值。
