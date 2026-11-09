# 开发、探针与发行维护

本页命令默认在仓库根目录执行。玩家不需要这些工具，安装操作见 [玩家使用说明](player-guide.md)。


## 文档、实验记录与检索

`player-guide.md`、`tester-guide.md`、`development.md`、接口说明和计划等正式文档正常纳入 Git。原始证据 `docs/evidence/` 和按用途命名的研究 `research-*.md`、评审 `review-*.md`、测试 `playtest-*.md` / `fix-playtest-*.md`、运行记录 `runtime-*.md`、发布检查 `release-readiness-*.md` 默认保留在本机，由 `.gitignore` 排除新文件。

文件仍在原位置。默认 `fd` / `rg` 遵循忽略规则；查实验记录时，明确限定 `docs/` 并加 `--no-ignore-vcs`：

```powershell
# 默认搜索，遵循忽略规则
fd -t f -e md . docs
rg -n -g '*.md' 'Steam|多人' docs

# 包含本地记录：按类别找评审，按内容检索 Markdown
fd --no-ignore-vcs -t f '^review-.*\.md$' docs
rg --no-ignore-vcs -n -g '*.md' 'Steam|isSingleQuest' docs

# 按日期筛选证据路径；--full-path 也匹配父目录
fd --no-ignore-vcs --full-path -t f '2026-10-31' docs/evidence

# 在指定一轮证据里查 JSON / Lua
rg --no-ignore-vcs -n -g '*.json' -g '*.lua' 'generation|requestId' docs/evidence/2026-10-31-party-mixed
```

默认搜索不等于“仅 Git 已跟踪文件”。精确列出已跟踪文档用 `git ls-files docs`；仅搜索其内容用 `git grep -n 'Steam' -- docs`。忽略的新记录不随 clone 或 Release 分发；团队需要的结论整理进正式文档，或审核后显式 `git add -f <具体文件>`。不要批量强制添加整个证据目录。

`.gitignore` 不隐藏已跟踪文件的修改。既有研究文档、证据保持跟踪；不删除文件、不改历史，不用 `assume-unchanged` / `skip-worktree` 掩盖修改。既有文档若要转成纯本地记录，另行确认后再取消跟踪。


## 本地验证

```powershell
npm ci
npm run build:nocopy
npm run typecheck
npm test
npm run check
npm run test:cli
python -m pip install lupa
npm run check:runtime
npm --prefix console ci
npm --prefix console run build
./native/webconsole/build.ps1 -Target Plugin -Configuration Release
./native/webconsole/build.ps1 -Target Standalone -OutputDirectory .local/release-bin
./native/webconsole/test-server.ps1 -BinaryDirectory .local/release-bin
```

`build:nocopy` 不部署；`npm run build` 会调用 deploy.js 写入探测到的游戏目录，但不重新构建前端和 DLL。DLL 变化必须退出重开游戏，普通复制不能重载它。不在一局中重置脚本。

前端 `npm --prefix console run dev` 通过 Vite 代理本机游戏后端；preview 不代替游戏服务。发布用单 HTML 不依赖 Vite。

## 探针按需运行

默认 deploy 和 CI 玩家包都不复制自动探针。`reframework/autorun-probe/` 保留研究代码。维护者通过：

```powershell
node cli/mhr.mjs doctor --json
node cli/mhr.mjs game run-script path/to/read-only-probe.lua --json
```

本地 Lua 文件存在时 CLI 上传内容并包装 executionId；只有对应执行的 report 才作为本次结果。运行前审查脚本是否只读、是否注册持续回调。新的诊断优先写一次性读数与有界输出，不注册每帧大快照、不反复重写历史文件。运行有写入效果的研究脚本必须明确目标任务与验收步骤。

独立模块往返/GC 探针源文件仍在 `reframework/autorun/lua/webconsole_probe.lua`，其 auto 入口保留用于开发验证，不进发行包。doctor 的业务健康检查不依赖该探针，`/api/probe/report` 也可供一次性脚本发布结果。

## 打包

白名单为 `scripts/release-files.json`；不要使用递归拷贝 autorun、framework/scripts、docs、dist 或整个工作区的打包方式。构建的 Lua 和单 HTML 必须打进运行包，但源码仓库继续忽略它们，不能为了发布再提交二进制或 dist。

打包前按 `.github/workflows/release.yml` 构建。FrameworkDirectory 指向固定 commit 的源码，已构建出 `build/bin/MHRISE/dinput8.dll`。仓库根的 package-release.ps1 是本地和 CI 共用入口，必须选择全新/空暂存目录及不存在的 ZIP 路径；不再自动删除任意暂存路径。

生成后自动运行 check-release.ps1，检查每个 ZIP 路径均属于白名单，manifest 列表、大小与 SHA256 对应，没有额外脚本/日志/编译中间文件。第三方许可随包保留。旧 q900101 JSON 不属于现用动态任务900102的必需文件，不打包；本版也不分发其它游戏和VR脚本/可选VR加载库。

默认分支的手动 GitHub Actions workflow_dispatch 和每日 UTC 20:00（北京时间次日 04:00）构建会更新 nightly 预发行版及固定 ZIP；非默认分支的手动构建只上传 artifact。v* tag 发布对应版本 Release。不要为检查包内容反复改标签；先完成 ZIP 与干净安装验收，再准备标签。工作区未提交内容不由 git commit 标识覆盖，不能将本地包当作已完成 CI 发布。

## 发行前检查

1. 构建和检查均通过，从最终 ZIP（而非开发机已有目录）检查清单。
2. 首次安装、更新安装、旧探针残留三种场景分别检查；不能静默删除用户其它模组。
3. 不带探针时网页/doctor 不误报整体失败；帮助页 `/api/connection` 正常。
4. 电脑与手机页面可用，手机地址包含端口。多网卡/无网卡返回值均可理解。
5. 完成单人一层、购物、结束、原生结算和恢复链；记录仍未验收项，不能把 mock 当真实多人。
6. Release 附使用说明、测试反馈模板和 build-manifest；确认没有存档、恢复 journal、IP 快照或本机日志。

发行文字以已完成的验收为准，区分本机双真实引擎、本地模拟传输和不同电脑官方 Steam；不能把任意一种扩大成全场景联机保证。


联机测试以《测试与反馈》和[联机运行说明](multiplayer-runtime.md)为准。本机双引擎已通过多波次、个人购物、共享猫车和失败回村。CI 可复用 REFramework fork 的固定成功构建 40834594055（commit 2e7ce5b97dce68cc742b5c80ad421213c551c803）；同时核对产物 revision 和 dinput8.dll SHA256 BCB318D59FAA28B979BE26460CA8DF815D602197E2605DC6D90E4AAF1AEEDB15。下载失败、过期、权限或哈希不符时回退从固定源码构建，绝不采用浮动 latest 二进制。


## Nightly 与反馈入口

维护者可执行 `gh workflow run release.yml --ref master` 临时构建。固定下载入口为 Releases 的 nightly，固定附件名 `MHR-Arena-Roguelike-nightly.zip`；包中 manifest 记录提交 SHA，测试双方应使用同一份附件。GitHub 定时任务可能排队延迟；仅成功的构建替换下载，不保证每天精确到点完成。Nightly 标签随成功构建移动，不移动 v* 版本标签。

`GET /api/diagnostics` 是按需下载 JSON 的端点，返回 DLL 身份、内存中的状态与回执，以及固定白名单文件（manifest、REFramework 主日志、runtime/error）的每份最多 128 KB 尾部；不能通过参数读取其他路径。不读取存档和配置密钥，也不启动额外周期写盘。快照是发布时刻的数据，可能和日志尾部的旧局记录不同。网页首页的下载按钮调用此端点。

HTTP 线程成功绑定端口后，游戏插件用系统默认浏览器打开 `http://localhost:11777/console`，独立测试进程不打开浏览器。重置 Lua 不会重启 HTTP 线程。电脑网页按需读取 `/api/connection` 显示手机地址，手机浏览器隐藏此提示；不自动更改防火墙或申请管理员权限。


## 扩展功能的边界

| 要改什么 | 规则与入口 | 验证重点 |
| --- | --- | --- |
| 价格、限购、怪池、曲线 | 网页策划工作台 → 配置校验 → RunCore | 显示、扣款和预览使用同一份规则；不得中途重算已选波次 |
| 新商品或服务 | RunCore.buy 记账；ShopWindow 交付、原生读回 | 明确失败回滚；不确定结果保留扣款、锁交易，不能自动重发 |
| 新原生能力 | NativeRuntime 或独立适配器；Bridge 分发命令 | 原生调用上下文、任务号与 unique、幂等性和完成后置条件 |
| 新联机字段 | MultiplayerRun 编解码与协议版本 | 主从权限、旧帧/重复帧、配置摘要、慢端确认与超时 |
| 新 UI / CLI 操作 | 同一 Bridge 命令与能力状态 | token 失效、拒绝原因、queued/applied/uncertain 的区别 |

普通业务能力通过既有命令队列扩展，不需要新增 HTTP 路由或重新编译 DLL。只有桥接/传输能力变化才动原生插件。原生对象的操作不能直接放进 HTTP 工作线程；也不能认为任意 Lua 回调都适合原生分配、结算或场景销毁。结束请求排队到 QuestManager.update 的修复有真实崩溃前后对照，不要为缩短代码改回 onFrame 直接执行。

购物事务变更的字段由 RunCore.purchaseCheckpoint / rollbackPurchase 统一列出。新增服务若影响其它业务字段，应同步扩展这里，避免各个前端各写一套退款规则。cartRestore() 兼容入口也调用 buy("cart_restore")；价格与禁售使用 shop 中该商品的 price/globalLimit，旧 cartRestorePrice/Limit 字段保留作配置格式兼容，不能作为另一套收款来源。当前恢复效果最多一次；globalLimit=0 禁售，设置大于1不会增加可恢复次数。

单人配置的即时/下波/下局生效点以策划工作台提示为准。开局装备、奖池、增益和节奏在个人准备前统一刷新，当前局保持原服务规则。联机初次入场要求全队规则摘要一致；波间全员集结、交易完成后，房主可提交配置提案，经固定名册 prepare/commit/release/done 屏障及各端原子保存后生效。当前波次与已生成选择不变，起始PT、猫车上限、装备/抽取/增益/节奏下一局使用；ACK绑定配置代号，即使有效摘要不变也必须重新确认。保存或恢复失败锁住开局，保留个人装备/物资恢复能力。普通结算无需 Reset：恢复完成后退役旧同步器、清除旧计划/ACK、轮换网页桥并重建个人状态，保留最新已保存配置。NativeRuntime 与会心钩子跨业务局复用，不能每局重复注册。更新 Lua 源码仍需安全回村后重载；更新 DLL 则需重启游戏。任务模板与地图身份不允许通过网页热替换。

HTTP 传输去重使用 DLL 对完整原始命令文本计算的 SHA256，而不是挑选若干业务字段；相同 request ID 仅接受逐字节一致的重放。重新编码、改变嵌套配置或会话字段必须使用新 ID，购物业务层去重仍独立保留。缺少完整摘要能力时，在执行前拒绝命令，不回退到不完整指纹。

装备发放共用 `equipment_catalog` 预检：DataShortcut 的显式 `isValid(PlArmorId/WeaponId)` 与 `getArmorBaseData/getPlainWeaponData` 均须通过，并核对返回数据的get_Id与请求一致，拒绝占位或替代记录。防具编码合法不代表系列存在；ID 不得超过原生32位范围，防具系列不得占用部位位段。网页提交先校验所有可选初始套装的五个部位、指定武器与全部奖池，失败不写配置或推进版本。磁盘加载的方案仍在开局前整组预检，`grantEquip` 也在预留槽、写恢复记录和发放前再次检查，覆盖其它调用入口。目录暂未就绪时拒绝操作并允许之后重试，不缓存失败或回退到“先发再看”。这些只读检查不证明装备玩法、模型或数值已经逐项验收。

验证按层推进：纯 TypeScript 规则 → 编译后的 Lua 沙箱与双进程协议 → 原生桥接 → 两个真实游戏引擎 → 不同电脑官方 Steam。单测通过不替代后两层。当前自动检查命令和[本地双客户端步骤](local-multiplayer-testing.md)共同维护；不要为低风险文字修改重复启动游戏。

2026-11-05 临时现场探针已保留在本地 `.local/archived-probes/2026-11-05/`，不提交、不打包；可用 `rg --no-ignore-vcs` 按内容查找。受控网页预览可运行 `python scripts/review-webconsole.py --port 11877 --seconds 120`，只绑定回环地址，使用有界内存队列；它模拟游戏 API，不能用作原生桥或联机验收。


NativeUi也必须跨业务重开复用：WebConsoleBridge.newScriptSession返回已清空输入的适配器，下一Bridge用它rebind新身份和任务读取器。仅换token，不重复注册原生输入钩子；旧sceneToken必须被拒绝。测试钩子数量时应剔除按需执行的实验脚本自身注册，或直接在原生操作前后测量差额。具体生产门槛与尚缺条款的实施顺序见[策划对照](design-coverage.md)。


恢复记录写入统一走 `writeRecoveryRecord` → `webconsole.write_recovery`（DLL 0.4.1）。不要在新的装备或背包流程里直接 `json.dump_file` 覆盖原始备份。原生接口只接受startup/pouch两个文件名、最多2MiB，写入/刷新临时文件后再替换，Lua再精确读回。进度变化才写盘，恢复轮询不能反复flush不变内容。增加新类型记录时需扩展明确文件白名单和中断测试，不能开放任意路径。
