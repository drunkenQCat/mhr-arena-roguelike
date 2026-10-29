# CLI 从启动菜单进入村庄：实机验收

2026-10-29，Rise 16.0.2.0、REFramework 5bae4701，现有 webconsole 内存桥。操作过程中使用 Computer Use 对照实际画面与 CLI 的 ui 状态；最终一轮从 Steam 启动请求开始，进入游戏的六项菜单操作全部由 CLI 发起，没有鼠标/键盘代操作菜单。

```powershell
node cli/mhr.mjs game launch --json
node cli/mhr.mjs game enter --slot 1 --timeout 120 --json
node cli/mhr.mjs doctor --json
```

最终结果见 [acceptance.json](acceptance.json)：`ok=true`、`scene=village`、`requestedSlot=1`，六项原生 UI 操作均有 applied 回执：

1. 关闭启动时的 MR-111-83 连接错误。
2. 确认自动保存提示。
3. 从“按任意键”进入标题菜单。
4. 选择“继续”。
5. 加载现有 1 号存档。
6. 关闭加载角色后再次出现的 MR-111-83 连接错误。

最终将游戏窗口置前，通过 Computer Use 看到角色在神火村桥上，已无上述弹窗；CLI doctor 通过。测试结束游戏保持运行，未启动肉鸽局。

## 对照过程中修正的问题

- 旧 UI 分区把连接错误停留状态表示成 unknown/loading=true；新增原生窗口文本、窗口类型、标题 FSM 节点和菜单状态观察。缺少玩家不再直接推断 loading。
- 存档预览已存在玩家对象，不能作为进入村庄的证据。
- 空存档有默认名字，新增猎人等级检查；本机 2、3 号空槽不再被标为 occupied。
- 新游戏/保存/覆盖与加载共用界面，只有实测 LoadDataSelect 节点获得 save.load 权限。
- 确认输入需要覆盖同一帧的多个条件读取，且标题鼠标确认需绑定实际菜单控制对象。接口不调用保存/加载内部 routine，也不直接强改 FSM 分支。
- 无按钮加载/连接提示只等待；村庄背景上的网络错误仍须关闭后才能宣告成功。
- 旧存档 UI 对象可能在进村后短暂存活；优先使用实际村庄就绪状态，一次 enter 流程最多发起一次 load。
- 提交使用 sceneToken/dialogToken，菜单稳定且心跳推进后才操作；旧 token 拒绝，uncertain 不自动重放。

## 验证范围与边界

- 151 项 Vitest、5 项自动进村 CLI 合同测试、既有 CLI 传输合同、Lua 语法与编译产物运行检查通过。单元测试不替代上述真实游戏结果。
- 全流程实机成功一轮；此前离散的启动确认、标题推进、存档加载和网络错误关闭亦分别验证过。尚未做大量启动压力测试。
- 网络错误关闭仅允许已验证的 MR-111-83 与 BUTTON_CURSOR_ON 窗口；未知可操作弹窗停止，未覆盖全部原生窗口，故 dialogsKnown 仍为 false。
- 地图编号没有新验证的访问器，mapNo 不伪造；位置采集和自动移动不在本轮验收范围。
- `saves load` 的 applied 表示原生加载已开始；`game enter` 额外等待村庄就绪。没有跨进程重启的 exactly-once 承诺。
- 重新准备测试现场时，终止的是本轮自行启动、已核对无活动任务的空闲测试进程；这不是 CLI 的通用退出能力。CLI 尚未实现 game exit。
- 调研用 ui_metadata_probe 已移出游戏 autorun；源码位于 autorun-probe，默认不部署，手动启用时快照最多写 60 秒、转换记录最多 32 项。正式 UI 通道不写持续快照文件。

## 原生依据

类型与签名来自本机 REFramework 反射，枚举来自仓库固定版本的 `sdk-dump/Enums_Internal.hpp`：

- `snow.gui.fsm.title.GuiTitleFsmManager.getCurrentNodeName(System.UInt32)`：观察到 AutoSaveCaution、Title_PressAnyButton、Title_TopMenu_Demo、ロード画面初期化。
- `GuiTitleMenuFsmManager.TitleMenuStateType`：PressAnyButton=1、TitleMenu=2；`TitleMenu.Continue=1`，与实际画面一致。
- `snow.gui.GuiManager.get_refGuiNetworkErrorWindow`、`GuiCommonInfoBase.getText/get_WindowType`、`SnowGuiCommonBehavior.isOpen`：观察实际窗口；Type=1 为 BUTTON_CURSOR_ON，2/3/5 为无确认按钮或被动连接/加载样式。
- `GuiSaveDataSelectMenu._SlotDataArray/_CurrentSlotNo`、`snow.LoadInfoSingleData._HunterName/_HunterRank`：读取原生存档摘要，选中已有槽位后让原生 routine 处理确认。
- `snow.gui.StmGuiInput` 的 `getTitlePressAnyButton`、`getDecideButtonTrg`、`getDecideMouseEventTrg`、`isNetworkErrorWindowButton`：受当前 UI token、操作上下文、控制对象和短时限约束的输入适配。
- 调研中只读反汇编核对了标题 Action.update、GuiManager.updateInfoWindowSYS 和 GuiSaveDataSelectMenu.routineLoadDataSelect 的输入调用分支。临时全量反射与反汇编留在 .local，没有加入日常日志或大体积 SDK 输出。
