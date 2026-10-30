# 傀异克服天彗龙（2134）斗技场兼容探针（2026-10-30）

## 结论

**兼容性成立**。傀异克服天彗龙（EmType 2134）可在斗技场（地图 10）任务内通过
`createEnemySetInfo` + 原生加载调度正常挂载、生成、战斗、致死、死亡结算。
五步证据齐全（probe_report.json，verdict=PASS）：

| 步骤 | 帧 | 证据 |
|---|---|---|
| 1 挂载 | 1 | emSetId=9, uid=900, 任务槽 1, type 2134，全新 BossSetParam（字段自源怪复制） |
| 2 原生加载 | 12 | 槽 State=1；EnemyManager boss 列表出现 uid 900/type 2134；hpMax=470、scale_Total=1.0 |
| 3 体型/围栏读数 | 60 | 位置 (-0.09, -0.56, -80.25) 在场内界内；scale_Base=0.899 |
| 4 定向致死 | 60 | `stockDirectForceKillDamage`（经 EnemyManager.update 钩子）开始 stock |
| 5 死亡事件 | 614 | `isDieBehaviorActive=true`，死亡时位置仍在场内 |

slot-released 超窗未释放（尸体清理慢于 30s 窗口），死亡证据已足；PASS 判定不含槽位释放。

## 过程中的三个新发现（对后续扩池直接有用）

1. **古龙的死亡事件钩子必须在 `EnemyManager.update` 上**。
   `EnemyCharacterBase.update` 钩子对傀异克服天彗龙完全不触发（派生类不调基类实现；
   小型怪如青熊兽会触发，2026-10-27 怪种探针因此侥幸成立）。`stockDirectForceKillDamage`
   对古龙有效，但死亡流程耗时波动大（同种两只：一次 50s+ 超窗后死亡，一次 10s 内）。
2. **入场动画是"高空入场后落地"**：生成后约 1.5s 时读位置在界外（下落中），数十秒后落稳场内。
   位置类验收必须在落稳后读，或以死亡时位置兜底（死亡姿态必然在地面）。
3. **任务槽的出生条件语义**（603 模板 `_BossSetCondition=[DEFAULT, EM1_HP, HP_EMx1]`）：
   - 槽 0 = 原任务目标（不可占用）；
   - 槽 1 = EM1_HP（65%）：探针强制 RequestLoad 可正常出生，全血（4700 档），位置在场内；
   - 槽 2+ = HP_EMx1（原怪死亡后在其位置出怪）：**原怪存活时强制加载会出界出生 + 血量分档
     （实测 hpMax=470 = 全血 1/10）**。挂载探针/生产 inPlace 出怪都应固定用槽 1。
   - 血量来源差异（4700 vs 470）本身也是难度表链路（总表 §3.1）需要打通的又一佐证。

## 运行环境与方法

- 游戏：Rise 16.0.2.0；活体任务 900102（骨套开局单怪波，原目标搔鸟 107 存活作锚）；
- 挂载协议与 2026-10-27 怪种探针一致（全新 BossSetParam 复制源怪位姿字段 →
  `createEnemySetInfo` → 槽写入 → `_BossLoadStartOk/_BossLoadDone` 复位 → 顺序表 → `_ExtraEmRno=5`）；
- 文件：`probe_report.json`（原始报告）、`probe_risen_valstrax.lua`（探针源码）；
  SHA256 见 `SHA256SUMS.txt`。

## 对 P2 扩池的意义

2134（Risen 之一）全链通过 → 其余 Risen（2075/2072/2073/2120）同为"古龙模型 + 傀异克服状态机"，
预期同链路可用，仍逐只探针确认（各古龙入场/机制差异：飞行、钻地、分身等）。
Apex 系与冥渊龙（135）继续按研究文档 §4 顺序跟进。
