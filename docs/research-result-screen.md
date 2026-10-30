# 任务结算页的 CLI 推进实验（2026-10-29）

结论：**已通过 HTTP 运行 Lua，在游戏原生结算输入路径内推进页面并正常回村。无需模拟 Windows 按键、点击 UI、修改 FSM 状态或外调结束回调。**

本轮承接 [HANDOFF-result-screen.md](HANDOFF-result-screen.md)。Computer Use 仅用于定位／恢复窗口和确认结算页、物品页、村庄画面；没有通过它发送游戏按键或点击。接任务、击杀、停止、重载、执行探针和查询状态都走现有 CLI。

## 可直接复用的命令

在项目目录执行：

```powershell
node cli/mhr.mjs game run-script reframework/autorun-probe/result_accept.lua --timeout 50 --json
```

脚本位于 [result_accept.lua](../reframework/autorun-probe/result_accept.lua)。它是显式执行的研究工具，不在 autorun 根目录，不自动接管玩家的结算页。

前提：当前为**单人自定义任务 900102 的结算页面**，原生结算节点为 `Reward` 或 `Payoffselect`。脚本成功的判据是原生村庄柜台已可调用且任务不再进行，不以“hook 已执行”或“请求已提交”判成功。返回 `verdict=PASS` 后再核对 `ui --json` 的 `scene=village`。

`quest_ready` 不是充分前提：该分类还可能覆盖返回倒计时／场景过渡，此时结果 FSM 尚未创建。工具会拒绝该情况，不能把空实例当成传送、保存或结果状态异常。

## 找到的实际调用链

真正的结果管理器是：

```text
snow.gui.GuiQuestResultFsmManager
  get_Instance()                 由继承链取得
  getCurrentNodeName(0)           实际节点名
```

之前尝试的 `snow.gui.fsm.result.GuiResultFsmManager` 等名称不是本机实际类型。当前画面的流程由不同的行为树 Action 驱动，不能只盯展示用的 GuiResultBack。

| 页面／节点 | 原生更新入口 | 本轮采用的输入 |
|---|---|---|
| 物品奖励 `Reward` | `snow.gui.fsm.GuiQuestResultFsmActionReword.update(ActionArg)`，注意游戏名称拼作 Reword | 物品选择时使用 `StmGuiInput.getDecideMouseEventRep`；结束按钮由经典决定键处理 |
| 报酬汇总 `Payoffselect` | `snow.gui.fsm.GuiQuestPayoffFsmActionSelect.update(ActionArg)` | `StmGuiInput.getDecideButtonTrg` |
| 动画 `PayoffAnimation` | `GuiQuestPayoffFsmActionAnimation.update` | 不注入，等待原生动画 |
| `Save`、`End` | 原生保存／结果结束 Action | 不注入，等待原生流程 |

`getDecideButtonTrg` 与 `getDecideButtonOrTrg` 在本次导出指向同一个原生函数。研究时要按实际地址辨认别名，不能因为名字不同就认作两条独立输入链。

### 原生代码依据

读取 PID 41084 的机器码，以同一进程导出的元数据关联方法名。关键分支如下；地址只用于此次证据，不可硬编码到正式功能。

```text
GuiQuestPayoffFsmActionSelect.update
  7ff7c15fb7db  call getDecideButtonTrg/getDecideButtonOrTrg
  7ff7c15fb7e0  test al, al
  7ff7c15fb7e2  jne 7ff7c15fb80f
  ...确认分支通知 ActionArg 完成本节点...

GuiQuestResultFsmActionReword.update
  7ff7bfe496af  call getDecideMouseEventRep
  7ff7bfe496b4  test al, al
  7ff7bfe496b6  jne 7ff7bfe4980f
  7ff7bfe49819  call GuiQuestResultFsmManager.sendRewardItem

  ...结束按钮的选择分支...
  7ff7bfe49929  call getDecideButtonTrg/getDecideButtonOrTrg
  7ff7bfe49b52  cmp [manager + 0x84], 0     ; RecvButtonCursor
  7ff7bfe49b59  je  7ff7bfe49b8a
  ...非零是出售分支...
  7ff7bfe49b8a  call decideSendAllItem      ; 零是领取分支
```

这给出了输入与原生道具处理之间的直接联系。脚本不自己添加奖励、不自己修改钱包或库存，不调用 `sendRewardItem`／`decideSendAllItem`；它只让引擎原本的输入判断成功，再由原生分支处理。

## 对交接结论的修正

1. **`andTrg` 不是托管对象返回值。** 完整 TDB 签名返回 `System.Boolean`；`isOperationTrg` 的原生指令也在调用它后直接 `test al,al`。hook 的返回参数是指针包装的原始值，userdata 不等于托管对象。不能对它 `to_managed_object` 后改所谓标志字段。
2. **当前结算页没有调用 isOperation 系列。** 对 `Payoffselect` 观察 120 帧，`isOperationTrg/Rep/On` 均为 0 次；`Reward` 页结果相同。这排除了此前最看好的候选，而不是再把三个接口统统强制 true。
3. **经典决定键可以推进报酬页。** 在正确的 Action.update 调用范围里，实际命中一次、返回一次 true，就进入 `Save` 并回村。先前全家桶实验无效的具体原因没有完整追溯，因此不能反推“此页不读决定键”。本轮以成功路径与原生调用点为准。
4. **结果 FSM 的 End 与 QuestManager 的 EndFlow 是两套状态。** 不应外部调用 `onResultEnd()` 来模拟用户接受结果，更不应只清内部计数器。
5. **任务身份先清零是正常卸载过程。** 成功返回时，旧任务 identity 会先消失，村庄可操作标志稍后才变真。原型第一版因此误报 FAIL；当前版本在旧任务清除后停止输入，继续有限等待村庄。若出现另一个活动任务则中止。
6. 现有 `dialog.close` 并不等于“任意确认窗都支持”：当前 NativeUi 对可关闭弹窗仍有具体白名单。此工具不把保存错误或未知弹窗一律点确定。

## 输入范围与开销

- 绑定开始时的任务 unique，并拒绝在线任务与正在狩猎的状态。
- 只有进入两个指定结果 Action.update 的调用范围，且实际 FSM 节点匹配时，才可能返回模拟确认值。
- 最多每 12 帧一次，最多 100 次、40 秒／2400 帧；正常完成后 hook 立即恢复透传。
- 奖励页只在 GUI 显示时处理；结束按钮若选中出售（RecvButtonCursor 非 0），不替用户确认。
- 动画、保存、结束、村庄阶段均不注入。不写 Warp／结构体，不强改状态机，不调用保存／结束回调。
- 最终一次 `publish_probe` 报告，无周期性文件写盘。道具箱快照只在开始和完成时各读一次，用于本轮验收。
- 这是 CLI 研究脚本；每次执行会留下已失活的 hook／帧回调，长驻功能应统一安装一次。实验结束可在村庄用 `game reset` 清除。

## 实机验证范围

原始导出、反汇编摘录、过程报告及最终报告见 [证据目录](evidence/2026-10-29-results-accept/README.md)。

- **失败／空报酬结果页**：从 `Payoffselect`，1 次经典决定键确认，进入 `Save`，CLI 与画面均确认回村。
- **成功／有物品结果页，第一轮**：6 次物品确认、2 次经典决定键确认，经过 `Reward → PayoffAnimation → Save → End`；原型报告因 identity 清除时机误报 FAIL，但后续 CLI 与画面均确认正常回村。保留误报原件，不把它伪装成 PASS。
- **成功／有物品结果页，复测**：当前仓库脚本返回 `PASS / after=village`，共 738 帧、8 次脉冲（6 次物品确认、2 次决定键确认）；道具箱 ID 68157877 增加 1、68157958 增加 2、68157959 增加 3，总计 6 件。此前第二轮虽正常回村，验收仍因读取已卸载 FSM 而 ERROR，原件亦保留；当前版本不再读取已清理的结果对象。

尚未验收多人、普通官方任务、道具箱全满、特殊鉴定／护石／珠子奖励、保存错误及未知弹窗。它们不能因为此次低层自定义任务通过就被宣称支持。

另外，本轮反复观察到 `test kill-all` 已杀怪却因只有 queued 回执而以退出码 6 结束；这是独立的 CLI 协议问题，不是结算页输入失败。本轮没有扩大范围修改它。

## 正式接入建议

可在 `NativeUi` 增加 `results` 场景和 `results.accept` 动作，将已验证的两个 Action 作为输入上下文；统一装 hook，并让命令携带 bridgeId、任务 unique、结果页面 token。完成回执应在原生结果面板退出且村庄可操作后发布，不能刚注入就写 applied。

目前交付为显式 CLI 研究脚本，**没有擅自把自动领奖／保存接入常驻肉鸽流程，也没有新建一个已实现的 `results.accept` 命令**。
