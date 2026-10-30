# AU 极强单怪波端到端验收（2026-10-30）

## 验收路径

```
run start --armor "铁套（攻高防低）" --test-layer 16
  → state: layer=16, 三选项均为"Single · 极强怪单怪"，rewardMul=1.7，rewardPt=374（=220×1.7）
run choose --index 0        # 嗟怨怨虎龙（1369，native map-10 模板怪）
  → wait: stage=Combat, enemies=[(0, 1369, alive)]
test kill-all
  → +10s: stage=Selecting, pt 150→524（+374），killedUltimates=["嗟怨怨虎龙"]
state_after_clear.json       # 归档的结算后快照（layer 17 选项同为极强单怪 374 PT）
```

## 结论

| 策划案条款 | 实测 |
|---|---|
| 极强怪仅 Type A 单怪 | ✓ ultimate 池只产出单怪 AU 选项 |
| PT 奖励 1.7x | ✓ 220(ultimateBase) × 1.7 = 374，实发 +374 |
| 本局记录极强怪讨伐 | ✓ `killedUltimates=["嗟怨怨虎龙"]`（state 新增发布字段） |
| 傀异克服天彗龙/1303/1369 可入选 | ✓ 三选项含嗟怨怨虎龙/激昂金狮子（天彗龙 1366 亦在池） |

## 新增测试接缝（本票实现）

- `RunSession.start(armor, spike, testLayer?)`：startRun 后直跳目标层再生成选项（仅单人离线测试用途；非法值拒绝开局）；
- 桥命令 `startRun.testLayer` 与 CLI `run start --test-layer N` 全链打通；
- state 快照新增 `killedUltimates` 发布字段；
- 单测：`run_session.test.ts` "M3.5 test-layer seam"（跳 16 层生成 ultimate AU 波 + 非法值拒绝），全量 203/203。

## 环境说明

- 波次生成走原生接任务路径（quest_installer 表注入 + 原生接取），嗟怨怨虎龙在原生地图 10
  模板出现过（arenaMonsterIds），出生/清波无异常；死亡由 test kill-all 原生致死。
- 探针局教训沿用的坑位修正：结算画面 result_accept 需在 FSM 就绪后重试（auto-timeout 兜底回村）。
