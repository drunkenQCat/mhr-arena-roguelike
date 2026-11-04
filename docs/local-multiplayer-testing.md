# 单机双客户端联机测试

一台电脑可以运行两个真实 Rise 引擎，并在本地模拟 Steam 环境中测试原生入场。2026-11-04 已用喜羊羊和圣光猫完成：建大厅 → 搜索加入 → 房主发布原生任务 → 客机看板参加 → 客机准备 → 房主出发 → 两端进入同一任务。

该环境适合排查原生入场、实体复制及模组同步问题；随后已验证自定义肉鸽四波、原生讨伐复制、清波集结和个人购物；仍须验收普通武器伤害、捕获、猫车、掉线与恢复。它不代表官方 Steam 认证、跨公网连接或真实朋友联机已验收。

## 本机已配置环境

| 项目 | P1 | P2 |
| --- | --- | --- |
| 实例目录 | `C:/TechProjects/MHR-MultiTest/Instance1` | `C:/TechProjects/MHR-MultiTest/Instance2` |
| 启动入口 | 本目录 `steamclient_loader.exe` | 本目录 `steamclient_loader.exe` |
| 控制台 | `http://localhost:11777/console` | `http://localhost:11778/console` |
| 实际存档根目录 | `%APPDATA%/Goldberg SteamEmu Saves/1446780` | 本目录 `_storage_/p2-ready/1446780` |
| 本轮角色 | 喜羊羊 | 圣光猫 |

两个实例的大型资源用硬链接共享；程序、插件和配置独立。不要修改共享的 pak 资源。启动器的工作目录必须是对应实例目录；官方 Steam 客户端应退出。此表是当前本机实验布局，发布包不包含模拟器、游戏资源、存档或测试探针。

1. 启动 P1，进入喜羊羊；再启动 P2，进入圣光猫。
2. 从信使进入线上菜单，由 P1 创建大厅。
3. P2 搜索大厅，核对房主名和人数，再加入。
4. P1 接取原生集会所任务；P2 在任务板选择“参加集会所的任务”，确认任务与房主。
5. P2 准备后，由 P1 出发。两端进入任务后核对任务身份及人数。

角色槽不能固定假设；用 `node cli/mhr.mjs saves list --base-url http://127.0.0.1:11778 --json` 重新观察，以角色名为准。本轮最终 P1/P2 分别加载槽2/槽1。

## 身份与存档的关键条件

两个角色槽位不等于两个网络身份。最初两个实例都读取了全局模拟身份；原生读回的 self 相同，P2 搜索不到 P1 大厅。

本机游戏实际加载的模拟 DLL 位于 `_storage_`，因此 P2 身份配置在 `_storage_/steam_settings`，存档配置在 `_storage_/local_save.txt`（内容 `p2-ready`）。把文件只放在实例根目录，并不能证明配置生效。接手时应核对实际加载路径和运行时网络 ID。

同一份 Rise 存档不能直接换身份读取。本轮设置独立 P2 身份后出现 `MHRS-000C-0000`；没有确认“创建新数据并覆盖原数据”的提示。随后以备份为输入，通过 [MHRise Save Converter](https://github.com/hashcade/mhrise-save-converter) 生成独立副本：

- 源存档用源身份解密；目标输出绑定 P2 身份。
- 先在全新空白测试目录，由目标身份原生创建系统存档，再将它作为 `--target-reference`。
- 本轮源 Curve Index 为70，目标原生模板为50；这些是本轮测量值，不能当作其他账号的默认值。
- 只通过转换工具的校验仍不够，必须实际加载目标角色。本轮 P2 已加载圣光猫并进入村庄和任务。
- 原共享存档与原版 Steam userdata 保留；未用转换输出覆盖它们。转换失败的副本与目标空白模板留作诊断，不应替换当前 `p2-ready`。

转换工具的维护者仍声明 Steam→Steam 路径存在未完成的实机验证。本轮结果只证明这份测试存档与当前环境成功，不能保证任意存档都可迁移。

## 本轮验收与证据

实际读回的结果：

| 检查 | 结果 |
| --- | --- |
| 大厅两名成员、不同 self、同一 owner/lobby | 通过 |
| 客机原生看板包含房主任务10101 | 通过 |
| 客机原生确认参加、准备，房主出发 | 通过 |
| 两端 `isPlayQuest=true`、`getQuestPlayerCount=2` | 通过 |
| 两端任务 unique/session 相同 | 通过 |
| 两端 PlayerList 均有两个原生玩家实体 | 通过 |
| 自定义900103共同入场、四波inPlace、原生讨伐复制、集结与个人购物 | 本机双真实引擎通过 |
| 猫车与恢复 | 双端共享次数、400 PT恢复一次通过；R12两端三猫失败后自动回村通过 |
| stop自动回村 | 两端自动完成原生结算并回村通过 |
| 普通武器伤害、捕获、掉线恢复 | 未验收 |
| 官方 Steam 账号间联机 | 未验收 |

本地原始记录在 `docs/evidence/2026-11-04-two-characters/`。该目录按仓库约定被 Git 忽略，使用 `rg --no-ignore-vcs` 或 `fd --no-ignore-vcs` 查找。最终结果见 `verification-summary.json`、`p1-in-native-quest.json`、`p2-in-native-quest.json`；存档备份位置见 `backup-location.txt`。

实验使用既有 CLI、原生菜单回调/有界输入和只读身份探针。Computer Use 本机管道当时不可用；没有伪造名册来代替两个引擎。


## 后续肉鸽回归与环境注意

2026-11-04后续成功局由P2（圣光猫，11778）担任房主、P1（喜羊羊，11777）担任客机。同一任务900103连续完成入场校准、Single、Sequential、Simultaneous；两端UID和实际最大HP一致，逐波奖励、原生袋发货与个人钱包隔离通过，最终停在L5选波。原始记录和未解决问题见本地`docs/evidence/2026-11-04-multiplayer-roguelike/README.md`。

顺序启动两个loader，并在每次启动后核对进程加载的steamclient64.dll来自各自实例。并行启动曾造成P1加载P2的模块，不能只靠HTTP端口或窗口标题判断隔离。两端实际_storage_/steam_settings均显式固定各自身份。

冷启动搜索持续无结果时，后续追踪发现两端原生联网警告未关闭；有界确认 SnowSessionManager.routineWarning 后，客机搜索立即返回房间。此前“先各建一次大厅再退出”属于间接恢复步骤，不能作为必要条件，也不应当作官方 Steam 联机的要求。角色槽仍应按名称重新读取。


## 2026-11-05 回村与猫车复测

停止后停在 Reward / Payoffselect 时，原生在等领取奖励、确认结算。直接 closeResultPayOff 只隐藏窗口；onResultEnd 不能替代原生状态机。新增 NativeUi 适配：原生 receive-all 回调、仅在 Payoffselect 的有界确认、等待保存完成，再确认村庄看板可用。R8 同任务1469683623两端已自动回村，returnFlow.complete；不是只观察到窗口关闭。

使用原生 PlayerQuestBase.update 中一次 setDie 触发真实猫车，而非直接改死亡数。R9 同任务1070862936完成客机猫车，两端死亡数1、剩余2；房主恢复后两端死亡数0、剩余3，房主500→100PT、客机保持500PT。修正了旧服务只写原生计数、未更新 Core.cartsLeft/cartRestoreUsed 的接线错误；原生明确失败时完整回滚标记、钱包和次数。

R7/R9失败回村出现原生C0000005。R10用全新进程、首波原生怪、无Reset且无承接异常再次复现，排除了这些先行异常作为必要条件。只读进程采样显示：QuestManager._SyncQuestDoneKeep（本版本偏移0x298）指向的原生消息最初有效、引用数1；约9秒后同一内存已被回收复用，但字段仍保留旧指针。清理调用者RVA0x2aec74a正是释放这个字段，随后在managed release的RVA0x4167e53崩溃。不是由最近的导出符号名称猜测音频问题。

原生反汇编确认setQuestFail经netSendQuestDone分配并保留结束同步消息。旧NativeRuntime.finish从普通Lua onFrame直接调用。现改为记录结束请求，在QuestManager.update原生更新的post回调执行，重验任务号、unique、房主角色与Play状态；原生已经结束则不再请求，异常不重放。钩子只排队一条诊断，下一普通帧才写盘。没有给悬空消息强加引用、改指针、跳状态机或强制保存。

R11完成三猫后玩家重生再停止的正常回村，但途中原生MR-230-94断线，不能算完整双端验收。R12则在同任务900103/unique20630618内，客机→房主→客机三猫、两端共享3→2→1→0、Finished、原生Payoffselect→Save→End、实际村庄看板可用与returnFlow.complete，完整通过。相同触发方式的修复前后对照支持将问题定位到结束请求的原生调用时机/对象生命周期；引擎内部具体回收器细节不作超出证据的断言。

后续已通过正常的独立启动命令重启两端并完成复测，没有修改PowerShell环境、安全软件或策略。文章所述HTTP_PROXY/HTTPS_PROXY/ALL_PROXY污染在本机进程、用户、系统三级均未发现，不能把此前拒绝归因于它。临时500PT配置的磁盘文件已恢复为原来的150PT；R12使用默认150PT。证据在本地 `docs/evidence/2026-11-04-return-carts/`，不加入发布包。


R13再以新进程完成inPlace续波后的三猫回村：同任务unique1165143093，先清初始怪、集结选波并生成新的原生UID，再三次猫车，两端共享次数归零，自动领取奖励、确认结算、等待原生保存，最终均实际回村，进程继续响应。R12/R13两条完整通过路径分别覆盖首波失败与续波后失败。结束后在村庄重置脚本清除CLI注入的临时钩子；正式脚本与配置保留。
