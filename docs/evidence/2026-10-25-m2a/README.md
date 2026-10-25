# M2a 实机验收 — 2026-10-25 — PASS

玩家报告：进入 900102 后场地只有第一只怪；杀掉后第二只自行出现；两只清完计数 2/2、任务正常结算。
配置与预期一致（槽 0 Great Izuchi/98 DEFAULT，槽 1 Great Baggi/54 EM1_HP，2-6 空）。

## 机器证据（拷贝自 <game>/reframework/data/）

- mhw_rogue_boot.json：900102/603/map10 安装就绪，route=reentry，hooks ok=true
- mhw_rogue_runtime.json：hooks-installed(900102, solo) → invincible ON →
  test-kill uid=0 (hp 6251, nativeDeathsOnly) → test-kill uid=100 (hp 6040) → invincible OFF
  ——两次原生讨伐对应两个槽位（uid 0 与 100 不同实例），观测层（questEnemyDie+UID 判定）在实机工作。

## 结论

- BOSSRUSH 顺序出怪：引擎接受运行时克隆任务的怪表与 EM1_HP 条件 ✅
- 讨伐检测观测层：实机确认 ✅（此前标注"未复验"的末笔修复就此关闭）
- 全项目地基级未知数清零。下一步：M2b/c 完整循环实机复验（docs/m2-testing.md 步骤 1-6）→ M3 商店。
