# Monster Hunter Rise 自由竞技场交接

更新日期：2026-10-18（Asia/Shanghai）。开始工作前先读本文件，再读 README.md 和 free-arena-validation.md。

## 用户目标与优先级

首先实现可接取、可进入、可返回的独立「自由竞技场」。用户要求：这是一切的基础，实现后再谈其他。竞技场验证通过后，逐步实施之前的肉鸽策划案。当前没有完成竞技场验证，不得宣称实现完成，也不要先扩展波次、商店或多人玩法。

原始策划案位于另一个工程：
- `C:/TechProjects/About_MyRepos/About_Games/mhw-moddev/docs/ref/design-v1.3.docx`
- 对应文本：`C:/TechProjects/About_MyRepos/About_Games/mhw-moddev/docs/ref/design-v1.3.txt`

该方案原为 World 编写；Rise 的怪物、装备、地图和接口不能直接照搬。后续需要保留玩法目标，明确 Rise 的差异与待确认项。不要把 World 的地址、插件、接口或任务操作当成 Rise 的依据。

## 工程与运行环境

- 本地工程：`C:/TechProjects/About_MyRepos/About_Games/mhr-roguelike-research`
- 游戏：`C:/Program Files (x86)/Steam/steamapps/common/MonsterHunterRise`
- 游戏版本：16.0.2.0，Steam build 17920865。
- REFramework：v1.5.9.1，revision 5bae4701396248a776c1de19f5be9552022295d5；Lua 5.4。
- 当前方案是 Lua，没有自研原生 DLL 编译步骤。
- 本仓库只在本地提交，未配置远程，也未推送。
- 最近检查未发现 MonsterHunterRise 进程；重新操作前必须再查，不能依赖这条历史记录。

## 当前实现

`reframework/autorun/free_arena.lua` 从原版村庄探索任务 101 克隆任务数据，改为普通柜台的 HUNTING 类型并注册独立任务 900101：
- 名称「自由竞技场 / Free Arena」，地图 10。
- 任务类型 HUNTING=1，时间限制 0，怪物槽位全空，小怪生成集合 0。
- 保留自带装备；不修改存档、背包或玩家数据。
- 使用 REFramework 脚本面板启动柜台内部流程：打开 QuestCounter、创建接任务会话、绕过顶层柜台菜单并请求出发。
- 当前尚未证实任务能成功承接或出发；内置确认框钩子扩大到整个发布流程后，实测仍停在“将承接任务，是否确定？”提示。
- 钩住 `QuestData.getQuestTextCore` 提供自定义文本。
- 入口：REFramework → Script Generated UI → Free Arena → Post and depart on Free Arena。

配套脚本：
- `free_arena_check.lua`：只读检查任务注册和基本数据，输出 free_arena_status.json。其 installed=true 绝不代表可进入任务。
- `arena_catalog.lua`：只读导出竞技场/探索模板；原版 78 项，注册后 79 项。
- `rogue_probe.lua`：最初的只读框架探针。
- `scripts/check-lua.js`：语法解析器；不验证游戏 API、生命周期或实际玩法。
- `scripts/build-arena.js` 和 `reframework/quests/q900101.json`：旧原生加载器实验产物，当前运行时不使用该 JSON。

## 已验证和未验证

已验证：Lua 语法；游戏启动；任务字典注册；map=10/type=1/time=0/空怪物槽位。2026-10-18 运行时测试能通过脚本按钮打开标准任务柜台并显示承接确认框。

用户确认：任务名称会出现在列表中，但旧 Lua 版在「名称出现后、尚未确认接取」时崩溃。因此菜单出现不等于功能可用。

未验证：承接确认自动化、承接成功、出发、进入场地、移动、结束任务、返回村庄、正常保存与退出。当前脚本尚未进入竞技场，不得把后续策划案标记为已经开始实现。

## 两次崩溃与当前候选修复

1. 旧原生 RiseQuestLoader 1.1.1：探索菜单崩溃。转储在 `.local/crash-arena-20261016`。旧 getQuestTextCore 四参数钩子与较新源码六参数版本不符，是兼容性缺陷，但不是已完整证明的唯一崩溃原因。DLL 与运行时任务 JSON 已移到 `.local/disabled-native-loader`，不要重新安装。Export All Quests 也曾抛异常，不要重试该旧工作流。
2. Lua 版：2026-10-16 09:47:32 崩溃。转储、调试输出、修复前脚本在 `.local/crash-lua-arena-20261016`。异常 c0000005，指令访问对象引用处理相关地址。小转储没有足够堆内存，无法识别损坏对象，根因尚未证实。

特别注意：同目录保存的 re2_framework_log.txt 属于 09:48 的重新启动。原崩溃会话日志已被重启覆盖，不能混用两个会话来推断崩溃前最后操作。

最初候选修复（安全返回文本钩子）已同时写入源码与游戏 autorun：
- 文本钩子每次返回新建 managed string，取代缓存的 managed string。
- 使用 QuestData 对象指针比对，取代钩子中的 getQuestNo 引擎调用。
- 2026-10-16 SHA256：`2C399E245DD4B9527220DAAF8BD616DBF2B5953E7CE14E14BBA30C71AF3E3B11`。
- 10:01:33 启动注册与独立检查通过；日志摘录 `.local/crash-lua-arena-20261016/candidate-startup.txt`。
- 这只是待实测的候选修复，不是已证明修好。

2026-10-18 普通柜台测试：
- AutoQuest 源码参考：`GuiManager.updateYNInfoWindow(System.UInt32)` 的 post-hook 返回 `GuiCommonYNInfoWindow.YNInfoUIState.Yes_on`；当前实现已照此加入确认钩子。
- 游戏内显示任务 900101 已注册，按钮启动后出现“将承接任务，是否确定？”；状态机停留在 `Selecting solo`，普通确认钩子没有推进弹窗。随后将钩子从仅 `accept` 阶段改为整个发布流程仍未自动确认。
- 最新脚本已复制到游戏目录，源码/游戏文件 SHA256 同为 `FD03F58E7E50BDBA207E4E6488652BC078DC6F470A05BA96D21F33BCC11CFC09`。`npm run check` 通过。
- 不要把打开柜台或弹出确认框记录为接取成功。下一步应诊断 YN hook 的实际触发/返回状态，或使用 AutoQuest 可验证的同等会话流程；避免继续依赖该停滞状态机。

参考：REFramework 官方 issue https://github.com/praydog/REFramework/issues/1049 说明文本钩子需返回 sdk.to_ptr 包装的字符串；RiseQuestLoader 源码也使用每次新建字符串。该参考本身不能证明我们的对象生命周期假设。

## 下一步的最小验证顺序

1. 核对进程、安装文件哈希、日志与转储时间；若有新崩溃，先归档再重启，避免日志覆盖。
2. 从「继续」加载原角色「量子猫」，不要新建角色，也不要覆盖存档。
3. 火芽 → 探索任务，先在列表停留至少 30 秒，反复切换普通任务与自定义任务详情。记录是否崩溃和对应日志。
4. 列表稳定后再接取，按画面提示准备并确认出发。验证地图、自带装备、空场、无时间限制，移动至少 30 秒。
5. 从游戏任务菜单结束探索并返回村庄，记录实际中文选项及保存结果。
6. 完成下述关游戏流程。只有进入和返回都验证后，才继续策划案。

若仍在列表崩溃：保留新证据，与普通探索菜单做对照；检查文本钩子参数/返回值/对象寿命与克隆数据初始化。不要盲目改内存偏移、重装已知不兼容 DLL 或把猜测写成根因。

## 电脑操作限制与用户授权

用户已授权操作游戏、安装模组、必要时用 PowerShell 关闭游戏。用户强调 Alt+F4 不能可靠退出 Rise。

此前 Computer Use 鼠标与 Insert 可用，但普通键盘输入没有可靠到达游戏；鼠标坐标与游戏内光标也出现偏差。最新测试误进入未提交的角色创建页面，没有完成创建，随后关闭进程。不要盲点菜单；每次操作后重新看截图。工具插件可能更新，使用当前 computer-use 技能文档，不要沿用旧 API 猜测。

当前等待用户复测最新候选版列表停留。需要接管时，说明准确的操作一步即可，不要重复请求已经给予的安装/关闭授权。

## 每次测试必须记录关游戏步骤

1. 正常路径优先：结束探索 → 返回村庄 → 等待保存完成 → 游戏系统菜单返回标题 → 退出并确认。具体菜单文字需实际观察。
2. PowerShell 检查：`Get-Process MonsterHunterRise -ErrorAction SilentlyContinue`。
3. 若正常退出无法操作，用户已授权强制关闭。核对目标进程路径确为 Rise 后，用 `Stop-Process -Id <已核对的PID>`，等待退出，再检查进程不存在。保存中不要终止。
4. 如实记录「正常退出」或「PowerShell 强制终止」，两者不可混称。

本次已记录：进程 116340 在制作人员名单界面被强制关闭以安装候选版；复测进程 136060 在未提交角色创建界面被强制关闭。后者 WaitForExit 完成，复查无游戏进程。

## 本地验证与资料边界

在工程根目录运行 `npm ci`，然后 `npm run check`。解析器使用 Lua 5.1 模式检查兼容语法，实际游戏运行时为 Lua 5.4。当前四份 Lua 均通过；这不能替代游戏验证。

版本库包含源码、说明、筛选后的文本日志和基础任务模板；`.local/`、node_modules、崩溃转储不提交。`.local/` 内包括原存档备份、第三方源码/二进制与崩溃证据，交接到另一台机器时需要单独安全保留，不能假设 git clone 会带过去。不要删除这些本地资料。

历史 evidence/2026-10-15 包含早期原生实验；2026-10-16 的原始注册报告也早于最新候选版。查证结论必须对齐时间、脚本哈希与后端。

## 2026-10-21 rewrite finding

The earlier flow was incomplete: it started `GuiQuestCounterFsmCreateQuestSessionAction` but never ticked its `_RoutineCtrl`, so the visible confirmation could remain stalled. It also omitted AutoQuest's `GuiManager.IsPlayerAllInputDisable()` hook, allowing the hunter to move behind the modal. `free_arena.lua` now advances the action routine on each frame, gates player input while automation is active, and retains the existing quest-counter selection/confirmation state machine. The in-game runtime test has not yet been performed in this session.

## 2026-10-21 startup smoke test

Launched the installed Steam game executable. REFramework log confirms `free_arena.lua` and `free_arena_check.lua` loaded, quest 900101 registered, and the `IsPlayerAllInputDisable` hook installed. The check report confirms map 10, quest type 1, zero monsters, and no time limit. Departure remains unverified: this session's computer-use surface exposed no native app/window, so the counter button could not be activated.

## Log correction (2026-10-22)

The latest run did activate the Free Arena start flow. At 19:38:21, REFramework logged `FreeArena routine: Quest-counter routine failed: caught (...) exception`; `reframework/data/free_arena_start.json` records the same failure. Therefore this is not merely an unclicked/untested button: registration and hook installation passed, but the quest-counter action routine threw during execution. The generic exception does not identify whether `isExecute()` or `execute()` threw; instrument those separately before the next runtime attempt. The earlier note that the button could not be activated was incomplete and is superseded by this log evidence.

## Current runtime result (2026-10-22)

The script was replaced with a native quest-list injection, without Generated UI or automated confirmation. Quest 900101 now appears under Village Quests > Free Exploration, as confirmed by the user. REFramework logged registration at 19:55:48 and list insertion at 19:56:59 and 20:00:37. The user entered the quest but saw a bear. This fails the empty-arena requirement. The registration checker reports zero configured boss slots, but it does not observe the active quest ID or runtime monster spawns; its `departure_verified=false` remains accurate. Monster ID 0 is None and Arzuros is 60 in the local quest editor asset. The cause of the bear is unconfirmed. Do not describe this build as a verified empty arena. The README has been corrected to reflect the current entry path and result; older sections above describe superseded prototypes.
