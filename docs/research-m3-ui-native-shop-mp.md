# M3/M4 调研：UI 花哨化、原生商店深层、灰名商品、多人可用性（2026-10-27）

## ① ImGui 花哨化：上限比现状高一个档次（143 个绑定全部可用）

对照 REFramework v1.5.9 `src/mods/bindings/ImGui.cpp` 的完整绑定面：

| 能力 | 绑定 | 用法 |
|---|---|---|
| 中文字体/层级 | load_font / push_font / push_font_size | 已验证；标题/正文/强调字号分级 |
| 配色主题 | push_style_color × N / push_style_var | 肉鸽主题色（暗金/血红），窗口圆角间距 |
| 正经表格 | begin_table / table_setup_column / table_set_bg_color / 排序规格 | 商品网格替代按钮列表 |
| 自绘装饰 | get_window/foreground/background_draw_list + path_line_to/path_stroke | 自绘血条、波次进度、层号徽章 |
| 反馈 | progress_bar、tooltip、is_item_hovered、begin_disabled、popup | 悬停详情、禁用态、购买确认 |
| 输入 | combo / slider / checkbox / input_text / is_key_down | 设置页 |

**做不到**：贴图/图标（无 image 绑定；美术素材进不了 imgui——这是与原生菜单美术差距的根源）、原生 tab bar（用按钮模拟）、动画（on_frame 手写计时器，简单）。
判定：主题化+表格+进度条+自绘装饰能把面板从"调试工具"拉到"精致 mod UI"，但到不了原生菜单美术。**值得做，一天量级。**

## ② 原生商店深层：接管与注入都通，PT 货币是深水区

元数据全量 dump（rogue_native_gui_metadata.json，220 方法）关键事实：

- **FSM 是静态单例**：`GuiItemShopFsmManager.get_Instance()`；`openItemShop()/closeItemShop()/isOpenItemShop()` 即接管入口。上次探针只调了 `activateOnly(4)`（场景激活），**从未调过 openItemShop**——"接管式打开"仍是未验证但低成本的实验。
- **商品列表可写**：`set_BuyItemListAll / ToPlayer / ToEnemy / Other`（List\<DisplayItemData\>）。`DisplayItemData.ctor(displayParam, paymentType)` 可构造；含 `ReferenceGameItemId`（物品）、`getPrice`、`PaymentType`。注入自定义商品 = 构造 Param 链 + 塞列表（Param 字段集需补一轮 probe）。
- **原生抽选菜单存在**：ItemShopAmiiboLot / MakaAlchemy（炼金抽护石）整套状态机——**"装备抽取"有现成原生 UI 雏形**。
- **货币是硬骨头**：`ItemShopBase.PaymentTypes = {Undefined=0, KyouseiPoint=1}`（另一命名空间 Money=0）。原生购买吃 Zenny/KyouseiPoint，**没有 PT 货币位**。PT 扣费必须 hook 购买 FSM action（GuiItemShopBuyYNFsmAction 系列存在且可 hook）——深水区。

判定：接管打开=低成本实验；商品注入=中成本（Param 链 + 实测）；PT 货币替换=高成本。**M3 主线维持 ImGui 商品 + 原生确认弹窗；"原生商店承载"作为体验升级专项（M4/M5），按上面的阶梯推进。**

## ③ 商店 [unavailable]：三个来源，两条可解锁

现状（shop_window.ts）：`perUnit` 且村庄/Selecting 才可买；**fill（补满）与 service（服务）被另一 Agent 保守禁用**——这就是满屏 unavailable 的主因。

| 类别 | 解锁条件 | 成本 |
|---|---|---|
| fill（弹药/素材补满） | tryAddGameItem 天然支持批量 addNum；补 `cap-owned` 一次调用 + 读回核对 | **低，可立即解锁** |
| cart_restore（猫车恢复） | 纯 Core 逻辑（CartsLeft+1），无游戏效果 | **低，可立即解锁** |
| buff_atk/def/crit（单轮增益） | 需要 hook 玩家攻防/会心持续一层波次——真实游戏效果接线 | M4（效果接线专项） |
| gacha_1..4（装备抽取） | 需要装备奖池 + EquipmentBox 写入 | M4 |

另：原生商店的灰名由 `DisplayItemData.getPurchaseStatus/checkPaymentLimit/VillageProgress/HallProgress/MRProgress` 驱动（进度门槛+限购+支付上限）——若走原生注入路线，自建条目可天然无门槛；与 ImGui 路线无关。

## ④ 多人可用性：架构无死结，四个接线点

社区事实（[Quest Editor and Loader Nexus #1061](https://www.nexusmods.com/monsterhunterrise/mods/1061)）：Rise 自定义任务联机需要**每个玩家都装 loader + 同一份任务**——正好符合我们的分发模型（每人安装器各自注册 900102）。

当前代码的 solo 假设（阻塞点清单）：

| # | 位置 | 现状 | M6 需要改成 |
|---|---|---|---|
| 1 | run_session L79/120/170/197 | `reading.online → fail("不支持联机")`，Fault 时释放钩子 | 区分主机/客户端角色：主机继续跑会话，客户端进入"跟随+本地钱包"模式 |
| 2 | quest_transport | `set_index(0)` solo 接取；AutoPost 无角色区分 | 仅主机 AutoPost；客户端禁用并等待主机发布（Sync 通知） |
| 3 | native_runtime HP/ATK hook | 双端都挂 | 敌人数值 host 权威——客户端 hook 应只读（防双重缩放），需实测 |
| 4 | RunCore 状态机 | 每客户端各自推进 | **确定性重放已预留**（RunState.Seed + 种子重放测试），缺主机广播种子/选波的 Sync 通道（SPL CustomPackets 或 ChatMessage 通道） |
| 5 | 钱包/商店 | tryAddGameItem 写本地袋 | 天然独立 ✓（策划案"每人独立 PT"成立） |

架构判定：**无死结**。设计期预留的"宿主权威 + 确定性重放"（RunState 单写线程、Seed 字段、纯 Core）正是为此。M6 工作量集中在：Sync 通道（封包或聊天指令兜底）、主机/客户端角色分流、hook 的 host-only 化。**商店/发放天然多人安全**（各自本地背包），商店 UI 多人可用性高。

## 建议排序

1. 商店解锁第一批：fill + cart_restore（半天，立即消除满屏 unavailable）；
2. ImGui 主题化+表格化（一天，观感跃迁）；
3. 原生商店 openItemShop 接管实验（半小时实机）；
4. buff 效果接线（M4，需要伤害统计 hook 基础）；
5. gacha 装备池（M4）；
6. 多人 M6（等单机循环稳定 + 一名联机队友）。
