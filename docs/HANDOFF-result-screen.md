# 交接：任务结算画面（quest_ready）自动跳过研究

> 交接给具备视觉能力的 agent。当前游戏进程已退出，接手后从全新启动开始。
> 本文是前一轮（无视觉、纯 CLI/探针）调查的完整经验。先读安全红线，再读已证事实。

## 目标

任务结束后的结算画面需要原生输入才能回村（任务书 §五 的 `results.accept` 项）。
用户已确认的人工通路有两条：① 点"全部出售"按钮；② **连续按空格/F 直到检测到人物回到村庄**。
目标：后端/CLI 能自动完成同样的事。你的优势是能看到画面——每次实验后立刻目视确认哪次让画面动了。

## 复现结算画面（约 4-5 分钟，用于反复实验）

```powershell
taskkill /IM MonsterHunterRise.exe /F          # 如需干净重启
node cli/mhr.mjs game launch
# 等 /api/health 200（约 20-40s），再：
node cli/mhr.mjs game enter --slot 1 --timeout 180
node cli/mhr.mjs run start --armor "骨套（均衡）"
node cli/mhr.mjs run choose --index 0
node cli/mhr.mjs wait --stage Combat --timeout 90
node cli/mhr.mjs test kill-all                 # 单波任务 → 结算 → 画面出现
```

注意：结算画面出现后，若没有会话驱动，游戏会**一直停在那里**（已确认 30 分钟以上不自动消失）。

## 探针工作流（不要手输 Lua）

写 Lua 探针文件 → `node cli/mhr.mjs game run-script <文件> --timeout 15` → 报告经内存桥回读。
契约：探针整体 pcall，发布 `{kind="run_script", script=<名字>, epoch=<wc.epoch()>, verdict="PASS/FAIL/ERROR", ...}`
经 `require("webconsole").publish_probe(json.dump_string(report))`；`game last-error` 读框架语法错误；
`ui --json` 看场景分类；`doctor` 看心跳是否冻结。参考实现 `reframework/autorun-probe/probe_script_api.lua`。

## 安全红线（本轮实测换来的，违反即卡死/崩游戏）

1. **绝不对结构体字段 `set_field(<managed instance>)`**——直接死锁游戏主循环（心跳冻结、脚本回调永久卡住，只能强杀进程）。已发生一次。
2. **不要从外部调用 `onXxx` 回调**。`QuestManager:onResultEnd()` 已反例：内部计数器全归零而画面纹丝不动，状态机与视觉脱节。
3. `sdk.create_instance("via.vec3")` 实例本身读写正常，但**经反射按值传参 invoke 成垃圾内存**。要传 `via.vec3` 用 sol2 的 `Vector3f.new(x, y, z)`（TSTL 里必须写属性调用 `Vector3f.new(...)`，不能写 `new Vector3f(...)`——TSTL 会编译成自己的类协议）。
4. 写 bool/数值字段安全（bool 的 `isResultSkip`、数值的 `_ResultOkTimer` 均实测无恙）；hook `snow.gui.StmGuiInput` 的方法安全（生产 TS 适配层在用）。
5. `sdk.new_vec3` 在本框架版本（5bae470）不存在。

## 已证事实（全部实机验证，游戏停在结算画面时）

1. 场景判定：适配层报 `scene="quest_ready"`，判据 `GuiManager.refGuiResultBack.isOpen=true`。
2. QuestManager 内部状态（停在结算画面时）：`_EndFlow=16, _QuestUIFlow=6, _UpdateFlow=3, _ResultOkTimer=89.0, isPhaseResult()=false(异常地)`。
3. `GuiManager` 的结算相关字段：`<isResultSkip>k__BackingField`(bool)、`refGuiResultBack / refGuiResultReward / refGuiResultPayOff / refGuiRewardDialog / refGuiDecoConfirmSell`。
4. 结算 GUI 组件方法：`GuiResultPayOff` 有 `skipBeforeProcess/skipAfterProcess/SkipAddAnimation`（跳动画）；`GuiResultReward` 有 `reqDecideAnimation`；`GuiResultBack` 只有背景（doOpen 等 7 个方法）。**它们是展示面板，不是流程驱动器。**
5. QuestManager 流程方法（都在，未穷尽验证）：`onResultEnd()`(⚠️回调) 、`resultEndSub()`、`onQuestReturn()`、`notifyReturn()`、`reqOpenDialogQuestReturn()`、`updateQuestEndFlow()`、`updateQuestUIFlow()`、`isPhaseResult()`、`questEndStatusCheck(Q_END)`、`requestQuestUI_EndQuestStart()`。
6. **输入层普查**（结算画面停留 12s，hook 全部 StmGuiInput 候选方法计数）：热方法只有 `getConfigOptionKeyType`(5990)、`andTrg`(1198)、`getDecideMouseEventRep`(599)；`getDecideButtonTrg` 家族 ≈ 0 次——**结算画面不轮询经典决定键 getter**。
7. `andTrg` 返回托管对象（userdata），不是位掩码；其内部字段未探。
8. 已排除的方案：结算画面上置 `isResultSkip=true`（15s 无反应）；决定键全家桶 hook 返回 1 持续 30s（9 个方法，无反应）；`getDecideMouseEventRep` 单独 override 30s（无反应）；`onResultEnd()` 外调（反效果，见红线 2）。

## 给你的候选方案（按建议顺序）

A. **`isOperationTrg/Rep/On`（完全未试，最有希望）**：StmGuiInput 还有操作制输入三件套。先 dump 签名（大概接受操作 ID/枚举），hook 后对"决定"操作返回 true。GUI 面板的输入大概率走这条路，而它不在此前任何实验里。
B. **`andTrg` 返回对象改写**：结算画面最热的轮询。dump 返回对象的类型与字段（找 Trg/On/Decide 标志位），在 hook post 段原位改写。
C. **`isResultSkip` 时机**：在 Carve 阶段（结算出现**前**）置 true，看结算是否自动快进。若成立，实现即"清波后自动置位"，成本最低。
D. **`_ResultOkTimer`**：结算时为 89.0，疑似自动回村倒计时。数值清零（安全写法）看是否触发推进。同时观察它是否自己倒数。
E. **命令风格组合**：`reqOpenDialogQuestReturn()` / `notifyReturn()`（未完整验证——交接时刻命令被取消）。若弹出的是确认对话框，现有 `dialog.close` 适配层已支持 confirmation 类窗口，组合即可闭环。
F. **你的视觉优势**：mashing 到底在哪些页面间推进（报酬页→出售确认→……→回村载入）目视即可绘制；每次 hook/置位实验后直接看画面，不用等 UI 分类器。

## 环境备忘

- fork 框架 dinput8 已部署（插件 API 三件套 request_script_reset/run_script/last_script_error）；插件 webconsole.dll 0.3.5 / protocol 4；CLI 基线 http://127.0.0.1:11777。
- 游戏目录：`C:/Program Files (x86)/Steam/steamapps/common/MonsterHunterRise`。
- 仓库基线：`23af3b9`（tp 已实机闭环）。工作区应干净；本轮探针都在临时目录未入库。
- 无敌开关 `test invincible on|off` 在场内实验前建议先开（本轮 tp 验证中无无敌被猫车两次）。
