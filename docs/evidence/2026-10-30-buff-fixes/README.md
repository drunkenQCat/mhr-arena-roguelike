# 恢复机制修复与 buff 叠加购买实测（2026-10-30）

## 结论与范围

修复复核报告中的五项主要问题，并在真实单人任务中完成四组攻击／防御／会心叠加测试。所有操作经 CLI／HTTP 执行，没有电脑输入操作。统计值来自原生 PlayerData 的限次只读采样，不是 Core 的影子数值。

基线（骨制套装、保留玩家武器）：攻击 340、防御 75、会心 −25%。每次购买分别增加攻击 10、防御 15、会心 10 个百分点。

| 测试 | 攻／防／会心购买次数 | 预期与实测攻击／防御／会心 | 证据 |
|---|---|---|---|
| 第一局第一波 | 3 / 2 / 3 | 370 / 105 / 5% | `stats-wave1_stable.json` |
| 第一局第二波（同一任务） | 1 / 3 / 2 | 350 / 120 / −5% | `stats-wave2_stable.json` |
| 第二局第一波 | 2 / 2 / 2 | 360 / 105 / −5% | `stats-run2_wave1.json` |
| 最终部署版本第一波 | 2 / 2 / 2 | 360 / 105 / −5% | `stats-final_stacked.json` |

每个有效采样报告均有六次观测（每 15 帧一次，共 90 帧），各次数值一致。第一局两次消费分别为 700、520 PT；最终版本消费 520 PT。不要使用 CLI 购买命令紧随回执返回的缓存快照计算单次余额，应看新鲜的 Combat 状态：`wave1-combat.json`、`wave2-combat.json`、`final-combat.json`。

## 生命周期实测

- 准备阶段已购买但尚未战斗：仍为基线，见 `stats-purchased-preparation.json`、`stats-wave2_purchased.json`。
- 清波立即撤销：`stats-after_wave1.json`、`stats-after_wave2.json` 均为 340 / 75 / −25%。
- 同一个原生任务续波不继承：任务 unique **229892058**，第一波有增益；第二波未购买，新增首领 UID 700 已存活，仍为基线。见 `run2-unbuffed-confirm.json` 和 `stats-run2_unbuffed_later.json`。这不是重进任务后的间接证据。
- 准备阶段重复购买后取消：`final-cancel-buy-*.json`、`final-cancel-stop.json`；随后新开局只获得本局新增购买的数量，未叠入前局未消费的攻击／会心。
- 战斗中主动停止：`stats-final_stopped.json` 恢复基线；会心 hook 已直通。
- 回村原装、清理与背包恢复：`final-integrity.json` 读回原 pack `[28,27,25,22,21,23,0,-1]`，临时骨制防具数量 **0**，背包分类与原始快照一致。恢复记录 inactive，见 `final-mhw_rogue_startup_state.json`、`final-mhw_rogue_pouch_state.json`。

## 五项修复

1. **持久化失败不再假成功**：检查 dump_file 的 boolean；换装前记录原 pack；发件前记录保留槽位；抽取也在发货前记录清理义务。记录失败时不发货。
2. **清理按实例核验**：使用记录槽位及可用的对象地址，再核对型号和类型。位置或实例不符则保留待办，禁止搜索同型号替代品；每件删除读回并记进度，重试跳过已完成条目。
3. **部分清包也保留恢复义务**：区分成功与 recoveryRequired；清包前保存各分类的物品 ID／数量，恢复时严格比对。备份缺失、被覆盖、读取失败及数量不符均不能当作恢复成功。
4. **buff 按波次消费**：准备阶段累加 pending；Combat 将其转入当前层 active；Carve 消耗；停止／故障／重载清理。原生任务回退重试可保留同层 active，不重复相加。
5. **会心计算无反馈**：post hook 只对原始返回值加当前会心增益，正确处理负 int32。没有跨 getter 调用的 lastCritSet，也不在 hook 内遍历托管对象。

玩家状态检查与诊断采样按运行时采样时钟限频；状态未变不写诊断文件。探针仅显式运行，90 帧后不再采样／写盘。

## 离线验证

198 条正式测试通过，见 `test-results.txt`；类型检查、TSTL 构建、Lua 语法及 Lua 5.4 运行检查通过。补充覆盖：原始记录保存失败、抽取记录失败、同型号多副本、部分清包、缺失／覆盖备份、恢复重试、同任务跨波消费、取消购买、原生重试、猫车数据重建、会心重复读取与负值。

故障注入属于离线测试。没有在玩家真实存档中制造磁盘失败、故意移动装备后删除或破坏背包备份。猫车重建本轮为离线验证，不冒充叠加后的真实猫车验收。

## 失败与边界记录

- `killAll` 仍有既有的 queued 终态回执问题；实际击杀由之后的任务状态和清波事件确认，未因超时盲目重复击杀。
- 第一局第二波清掉后，过早选择第三波触发 `Previous native bosses are still alive`，进入 Fault。`choose-wave3.json`／`wave3-combat.json` 保留了失败。名为 `stats-wave3_unbuffed.json` 的报告采于 Fault，**不作为第三波成功的证据**。第二局等待原生死亡状态稳定后，才取得同任务第二波成功证据。
- 重复运行同名脚本、同一 epoch 时，CLI 可能读到上一份报告。因此后续每份采样使用唯一文件名。`stats-wave1.json` 的 PlayerData unavailable 报告不计入成功结果。
- 本次不是完整怪物波次、多人、持久存档隔离的重新验收。装备跨进程地址变化／排序导致实例无法核验时，会保留恢复待办，而不会猜测删除同型号装备。独立的跨角色身份隔离仍需后续设计。

## 收尾

临时测试配置仅提高新局 PT 到 4000、缩短剥取与集结等待；已恢复原配置（startPt 150、carveSeconds 20），见 `config-original.json`、`config-restored.json`、`final-effective-config.json`。最终游戏在村庄 Idle，PT 150，无任务，无敌关闭；临时采样／结算 hooks 已通过 reset 清除。源代码与游戏部署 bundle 的散列记录于 `manifest.json`。

运行 `python docs/evidence/2026-10-30-buff-fixes/verify.py` 可复核以上存档中的关键断言；该脚本不操作游戏。
