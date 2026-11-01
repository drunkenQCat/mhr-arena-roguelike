# 发行整理验收（2026-11-01）

## 本轮交付

- 玩家包使用 scripts/release-files.json 白名单，不递归复制任何 autorun/scripts/dist/docs 目录。
- 最终候选 ZIP：.local/MHR-Arena-Roguelike-playtest-20261101-candidate.zip。
- 13 个文件，5442429 bytes，SHA256：20660a87ef89dc09a1578ed4b49d7b0e8f33ea6cfab7b15d46d4db2d8544ac0b。
- 无自动探针、框架示例、旧任务原型、测试程序、证据、日志或编译中间文件。实验源码保留，不删除历史研究。
- ZIP 包含中文使用说明、测试反馈模板、打开本机网页的 .url、版本与逐文件哈希清单，以及第三方许可。
- 网页增加“安装与手机连接”；GET /api/connection 按需列出已连接物理网卡 IPv4，过滤虚拟/隧道网卡与回环/链路本地地址。无需玩家先会查 IP。
- 开发测试工具默认隐藏，模块探针报告不再作为玩家健康状态前提。doctor 已增加无自动探针、业务心跳正常的契约测试。
- 原生插件版本0.3.6。未部署到真实游戏目录。

## REFramework 来源

本机没有重编框架。本次候选使用已存在的上游 fork CI 成品：drunkenQCat/REFramework 的 workflow run 40834594055、MHRISE artifact，关联 commit 2e7ce5b97dce68cc742b5c80ad421213c551c803，与本地源码和新 CI 固定 commit 相同。提取的 dinput8.dll 放入本地框架 ignored build 路径供同一打包脚本使用。

已检查 PE imports，没有对可选 openvr_api.dll/openxr_loader.dll 的静态依赖。玩家包面向普通桌面游戏，不包含可选VR库/脚本，不声称支持VR。

## 已完成检查

- TypeScript typecheck、248 条现有单元测试通过。
- 前端 vue-tsc + Vite 单 HTML 构建通过。
- Lua 语法及 Lua5.4运行检查通过。
- CLI契约检查通过，含新加无自动probe时doctor健康的场景。
- CMake/MSVC实际构建0.3.6插件与独立服务。
- 独立服务验证 health、connection（含空列表合法schema）、状态/结果未发布的503、网页、命令入队。
- 使用同一 package-release.ps1 完成真实ZIP打包，check-release验证白名单及全部哈希。
- test-release 对额外autorun探针、缺失插件、被篡改HTML三种ZIP分别确认拒绝。
- Edge实际打开构建HTML：默认无测试按钮，无探针FAIL面板；帮助页地址列出物理以太网，过滤原先显示的虚拟网卡/VPN；人工检查排版。
- git diff --check通过，无新增二进制、dist、日志进入Git跟踪。

## 边界

这是本地候选包，manifest.sourceDirty=true；工作区仍有先前其他任务的未提交改动。没有替用户提交、推送、打tag或触发远端Release，不能称为GitHub CI已经发布。本轮更新CI配置，后续提交后可先手动构建artifact验收，v*标签才发布。

没有在干净的真实游戏目录安装本候选，也没有真实手机或双客户端联机验收。本轮没有修复此前多人/去重/恢复链的其它评审项。界面、README与玩家说明均明确为单人测试版，不将mock视为真实多人支持。

对外正式发布前应从最终CI ZIP做干净安装和恢复验收，确认测试者理解存档备份、原生结算需要人工推进及当前实验边界。


## 目标更新：联机入场实验

用户要求发布给真实队友验证房主选波后共同入场。新增独立 MultiplayerEntry（900103），原生 Nullable<Int32> 大厅身份判断，房主选择固定任务码，队友导入，保留603集会所模板等级；HallCounter 承接结束后释放输入钩子，不自动出发。单人运行保护、PT、装备隔离不被放开。

实机已确认新版 Lua 加载、离线身份与离线 choose 拒绝。已结束旧局并确认 startup restorePending=false 后重载。第二 Rise 进程启动后退出，未建立第二个独立 Steam 身份，因此双客户端入场未验收。任务数据手动同码是初版前置，不宣称网络自动同步。预发行版的 manifest 标记 multiplayerEntryExperimental=true / twoClientEntryVerified=false / multiplayerSupported=false（完整多人）。

本轮 Computer Use 的游戏截图仍被鹰角启动器遮挡；尝试最小化、收起未成功，不把不可见的点击结果当作在线大厅创建成功。已有实际 Steam 会话仅一份。
