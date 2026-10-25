# 原生商店与游戏 GUI 调研（2026-10-24）

本轮范围：离线 SDK/枚举/RSZ 快照、现有 Core、社区原始源码核对，以及独立探针。未启动游戏；下述 API 存在性与实际可用性分开记录。主 bundle、部署脚本和游戏目录本轮均未改动。

## 结论

可以优先研究“原生通用组件承载肉鸽商店”，同时保留打开原生商店的实验。当前主要缺口是 PT 交易与真实背包接线，而不是画商品列表。打开原生商店不等于它已接受 PT 或自定义商品。

| 路径 | 当前证据 | 能解决什么 | 未解决什么 |
|---|---|---|---|
| `LobbyFacilityUIManager.activateOnly(4)` | 本地 `SceneId.ItemShop=4`；任务柜台已验证同一设施入口的用法 | 请求游戏加载原生道具商店设施 | 商店自身初始化、任务中资源、关闭恢复均待实测 |
| `GuiItemShopFsmManager.openItemShop()` | 当前 SDK 快照有无参方法 | 已有管理器上的商店打开入口 | 不能据此直接 new 管理器；首次加载应先走设施生命周期 |
| 原生选择列表 | `GuiManager.setOpenSelectWindow` 有字符串标题、字符串数组签名 | 商品分类、商品列表、三选一 | ValueTuple 结果、Guid 参数、所有重载待完整反射与实测 |
| 原生 Yes/No、信息窗 | 社区源码有 `System.String` 重载直接调用实例 | “购买回复药 ×1，花费 10 PT？”、余额不足提示 | 窗口所有权、输入轮询及关闭需由调用者管理 |
| 原生选项菜单扩展 | Bolt 的库真实修改 `GuiOptionWindow` 数据并 hook 输入/文本 | 游戏原生菜单风格、手柄导航的现成先例 | 更适合设置；商店的详情/数量/交易仍需实现 |

## 事实修正

旧文档 `research-spawn-and-ui.md` 不能作为确定结论继续引用：

1. **ModMenu API 并非仅是 ImGui 包装。** `ModOptionsMenu/OptionsMenu.lua` 实际创建原生选项数据、修改选项列表、处理原生选项窗口输入与文本。只读研究了其做法，没有把第三方实现复制进产品。
2. **Waester gist 不是打开原生 GUI 的先例。** 它 hook `openTitle` 来处理角色编辑券；没有主动调用 `openTitle`，不能证明菜单打开可行。
3. 不必先找到神秘 `InterfaceID` 才能试商店。`ItemShop=4`、`ItemBox=2`、`PointShop=24` 已在本地 `SceneId` 枚举中；本地选定的 `GuiManager` 快照未发现 `executeInterfaceID`，不再将它列为既定入口。
4. “社区没人做过”无法从有限搜索证明。本轮找到原生选项菜单、提示窗、确认窗的明确源码先例；未找到足以证明完整自定义 PT 原生商店的实例。

## 确认过的签名与枚举

可复查的本地证据保存在 `data/native_shop_gui_evidence.json`，包含 SDK 快照 SHA256、具体参数、枚举及缺失类型。SDK 快照是选择性导出，不是完整游戏类型数据库。

```text
GuiManager.setOpenSelectWindow(
  System.String headText, System.String[] selectText,
  System.Boolean[] isDecideSeCancel, System.Boolean isOpenSe,
  System.Int32 selectIndex, snow.quest.QuestData data, System.Guid headId)
GuiManager.getSelectWindowResult()
  -> System.ValueTuple<GuiCommonSelectWindow.Result, System.Int32>
GuiItemShopFsmManager.getBuyItemList() -> List<DisplayItemData>
GuiItemShopFsmManager.getSelectedBuyItem() -> DisplayItemData
GuiItemShopFsmManager.makeItemShopBuyMenuList() -> void
```

管理器有 `BuyItemListAll/ToPlayer/ToEnemy/Other`，数量游标 `NumCursor`，购买/出售菜单状态等字段。可据此追踪商品构建和数量选择，但仅改列表不能证明能拦住原生扣钱/发货。

社区 `ModMenuApi.lua` 的 `PromptYN` 使用：

```text
setOpenYNInfo(System.String, GuiManager.YNInfoUIState,
  SnowGuiCommonUtility.Segment, System.Boolean, System.Boolean)
updateYNInfoWindow(System.UInt32) -> GuiManager.YNInfoResult
closeYNInfo()
```

`Segment.Dialog=50`；`YNInfoUIState.SELECT_YES=0 / SELECT_NO=1` 是初始选中项；`YNInfoResult.Yes=0 / No=1 / None=2` 是轮询结果。两种枚举不能混用。选择列表的 `None=0 / Decide=1 / Cancel=2` 又是另一套。

**当前 SDK 导出遗漏重载**：`setOpenYNInfo` 标记有 2 个重载，却只保存了 Guid 开头的那一个。新增探针逐个方法导出，保留同名重载，不再凭旧 TS 类型推断字符串版本不存在。

RSZ 中还找到了 `GuiItemShopBuyYNFsmAction`、`GuiItemShopBuyYNAgainFsmAction`、`GuiItemShopFsmBuyMenuNumAction` 等真实类型名。RSZ 只能证实类型/字段线索，不能提供购买执行方法的完整签名，需要下一次运行时补齐。

## 商店代码当前缺口

`RunCore.getShop()/buy()` 已有价格、分类、容量、限购和 PT 扣除，但目前只修改 `wallet.bag` 与 `purchaseLog`。

- 没有游戏道具 ID 映射、背包发货，也不读取真实持有量。药品被游戏消耗后，影子背包不会自动减少，可能一直提示满容量。
- `fill` 当前按影子数量补满，不能直接作为游戏背包的补满数量。
- `service` 只是扣 PT 后返回成功文本，还没有实际服务效果。
- `getShop().canBuy` 没包含当前阶段；`buy()` 才限制 Prep/Choosing。GUI 必须展示阶段限制，并在提交时再次验证。
- `RunSession.Selecting` 对应 Core 的 Choosing；选波次后会直接接任务。若商店位于选波次前，应显式管理“打开商店→购买/取消→返回选择”，不能让后台接任务与确认窗争抢输入。
- 原生商店的实际货币、发货目标、买入容量与购买确认动作，尚未完成运行时追踪。不能通过临时篡改全局金钱把它伪装成 PT。

建议交易适配层以真实背包为准：读取当前数量及可接收容量→生成报价和发货目标→用户确认→复核 PT/阶段/真实数量→调用原生背包 API→读回确认成功后提交 Core 扣款和限购记录。不能直接先 `core.buy()` 再尝试发货。部分发货、确认连点、超时、取消、背包变化都必须有明确处理；初版保持单人、单件，确认闭环后再做补满和服务。

## 独立探针与下一次实测

文件：`reframework/autorun-probe/native_shop_gui_probe.lua`。不在 autorun 部署路径，不随 `npm run build` 安装。

准备好后将其放入游戏 autorun，再通过 ScriptRunner 的 Reset scripts 加载（建议重启或回村加载，避开上次卡住的文件选择器）。面板叫 **Roguelike research: native shop / GUI**。

1. 先点 **Export native GUI / inventory API metadata**：只导出类型、字段、完整重载和背包对象类型，不导出存档内容或改钱/道具。输出 `reframework/data/rogue_native_gui_metadata.json`。分别在未开店、手动开原生商店时导出，另存前一份比较生命周期。
2. **EXPERIMENT: native Yes/No dialog**：只显示无购买效果的原生确认窗，记录 Yes/No；30 秒超时关闭。确认鼠标/手柄可选、取消可返回、原游戏输入恢复。没有全局自动确认 hook。
3. **EXPERIMENT: open native item shop**：空闲村庄中请求 `activateOnly(ItemShop)`，15 秒后释放自己请求的设施；本轮未执行。它是普通游戏商店，仍可能执行原生交易，测试时只观察开闭，勿购买。探针自身没有购买、扣 PT 或发货调用。
4. 对已手动打开的商店再次导出，追踪 BuyYN 动作与 `DisplayItemData`、背包容器的具体类型、参数，才决定是否做 PT 专用商店 FSM。首笔交易限定回复药 ×1。

探针只关闭自己请求的 UI，不强制关闭其他菜单；不会创建一个脱离设施生命周期的商店管理器。运行时仍需人工确认画面与输入行为，不能把“管理器存在”当成打开成功。

## 来源

- 本地 `sdk-dump/sdk_types.json`、`sdk-dump/Enums_Internal.hpp`；RSZ 类型线索来自 `.local/save-editor/assets/mhrise/rszmhrise.json`（版本可能与当前游戏不同，实机必须再验证）。
- [Bolt 原生菜单仓库](https://github.com/Bolt-Scripts/MHR-InGame-ModMenu-API)：`reframework/autorun/ModOptionsMenu/ModMenuApi.lua` 中 `PromptMsg/PromptYN`；配套 `OptionsMenu.lua` 中原生列表及输入 hook。研究副本在忽略目录 `.local/native-gui-study/`。
- [REFramework 方法反射](https://cursey.github.io/reframework-book/api/types/REMethodDefinition.html) 与 [类型反射](https://cursey.github.io/reframework-book/api/types/RETypeDefinition.html)：完整重载、参数与父类型遍历。
- [Waester 原 gist](https://gist.github.com/Waester/7d6e080d1f4695feb683d997132f872b)：仅用于修正先前的引用含义。
