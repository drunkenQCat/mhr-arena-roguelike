# 斗技场肉鸽 · 联机多波次实验版

Windows Steam《怪物猎人：崛起》/ Sunbreak 实验模组。提供同场波次、Single / Sequential / Simultaneous 三选一、PT 商店和电脑/手机网页控制台。

**本机双真实客户端联机肉鸽回归已通过，跨电脑官方 Steam 联机继续收集反馈。** 房主选择入场任务，队友通过 Steam 自动准备任务表并从原生任务板加入；进入斗技场后自动接入局内循环，不需要开启 DebugMode。房主选择后续 Single / Sequential / Simultaneous，所有客户端先确认相同原生出怪记录再启动加载。房主判断清波与集结，每人独立获得 PT、在自己的网页购买补给；猫车恢复由房主购买并同步。保留已有装备和背包，不执行单人开局隔离。已验证范围和剩余边界见[联机运行说明](docs/multiplayer-runtime.md)；本机双引擎使用模拟 Steam 传输，不能替代跨电脑官方 Steam 验收。此包供约好朋友继续测试。

## 玩家从这里开始

1. 下载 Release 的 `MHR-Arena-Roguelike-版本.zip`，不要下载 Source code.zip。
2. 先备份存档并退出游戏。Steam 库 → 右键游戏 → 属性 → 已安装文件 → 浏览。
3. 将 ZIP 解压后的**内部内容**复制到 `MonsterHunterRise.exe` 同级目录。
4. 从 Steam 启动游戏，选存档进村，双击包里的 **打开电脑控制台.url**。
5. 网页默认的“联机入场测试”按房主／队友分别操作；“安装与手机连接”显示手机可用地址。完整步骤见[多人测试说明](docs/tester-guide.md)。

完整步骤见 **[玩家使用说明](docs/player-guide.md)**，包含不会查 IP 的操作路径、防火墙设置与撤销、更新/卸载、结算卡页和恢复失败处理。发行 ZIP 内也有同内容的 `使用说明.txt`，无需联网查文档。

参与测试见 **[测试与反馈](docs/tester-guide.md)**。初次测试请用已备份的角色；装备/背包恢复、长局及全部怪物组合仍有待验证。结果不明时不要重复购买或反复重置脚本。

## 包里有什么，没有什么

玩家包由 [发行白名单](scripts/release-files.json) 构建：匹配的 REFramework fork、一个游戏 Lua bundle、一个 HTTP 插件、一个内联 HTML、默认配置、中文说明、版本/哈希清单及第三方许可。无需 Node、Python、开发服务器。

不复制整个源码目录，不含框架的其它游戏/VR示例 autorun、旧任务原型、自动模块探针、autorun-probe、研究证据、CLI、测试 exe、日志、obj/map/pdb、node_modules 或前端 dist 目录。HTML 构建产物以 `console.html` 单文件放入包内，这是运行控制台所需；生成文件不提交 Git。

探针源码保留在仓库供研究。发行和日常部署均不再自动复制探针；维护者可使用后端 `game run-script` 按需执行一次 Lua。已有旧探针不会被安装器自动删除，请按玩家说明备份后移出 autorun。

普通界面默认隐藏开发战斗工具，不显示“未运行探针=FAIL”的误导面板。需要测试按钮时在网页帮助页手动开启，本次页面有效。CLI doctor 以实际业务心跳判定可用性，不要求玩家启动实验探针。

## 构建、CI 与发行

开发入口见 **[开发与发行说明](docs/development.md)**。CI 支持手动构建 artifact；推送 `v*` 标签才执行 Release 发布。REFramework 固定到经过核对的 commit，避免浮动分支悄悄改变发行依赖。

CI 会构建 TS→Lua、Vue→单 HTML、原生插件和 REFramework，运行类型/单元/CLI/Lua 语法检查，然后用同一打包脚本生成玩家 ZIP。脚本拒绝非空暂存目录，不递归删除调用者路径；最后检查 ZIP 白名单、逐文件大小和 SHA256。任何多余或缺失文件都会导致打包失败。

```powershell
npm ci
npm run build:nocopy
npm --prefix console ci
npm --prefix console run build
./native/webconsole/build.ps1 -Target Plugin -Configuration Release
./scripts/package-release.ps1 -FrameworkDirectory ../REFramework -StageDirectory .local/release-stage-new -OutputArchive .local/MHR-Arena-Roguelike-local.zip -Version local -ModRevision (git rev-parse HEAD)
```

REFramework 必须已构建出 `build/bin/MHRISE/dinput8.dll`。修改 DLL 后不要只刷新网页，要退出重开游戏。此命令不向游戏部署、不上传 Release；在尚未提交的工作区构建时，manifest 的 commit 不能代表全部未提交改动，应只作为本地候选包。

## 后端与网页如何连接

```text
电脑/手机浏览器（同源 Vue 单 HTML）
  → 游戏进程内 webconsole.dll（HTTP、有界内存队列）
  → Lua 游戏回调（校验、执行、回执）
  → RunSession / ShopWindow / 原生 API
```

HTTP 线程不直接调用游戏对象。Lua 发布心跳与业务状态，浏览器等待操作回执。正常通信走内存桥；配置及恢复资料仍需持久化。

电脑使用 `http://127.0.0.1:11777/console`。`GET /api/connection` 按需返回有效 Wi-Fi/以太网的 IPv4 手机地址。服务监听 `0.0.0.0:11777`，该值不是浏览器访问地址；手机必须使用电脑地址。控制台无登录鉴权，并有维护用 Lua 执行能力，只能在可信网络使用，不要做公网端口转发。

已有接口包括 `/api/health`、`/api/state`、`/api/results`、`/api/config`、`POST /api/command` 和 `/api/script/*`。详细命令见 [CLI 说明](docs/cli.md)；原生构建及依赖来源见 [native 说明](native/README.md)。

## 代码导航

| 路径 | 用途 |
| --- | --- |
| `src/core/` | 波次、PT、选项、集结和会话规则 |
| `src/game/` | 原生任务、倍率、装备/背包、商店、内存桥 |
| `console/src/` | 玩家界面、策划编辑器、连接帮助 |
| `native/webconsole/` | HTTP 插件与 Lua 模块、CMake/PowerShell 构建 |
| `scripts/release-files.json` | 玩家包明确白名单 |
| `scripts/package-release.ps1` / `check-release.ps1` | 打包及 ZIP 内容审计 |
| `cli/` | 维护者操作与按需 Lua 执行，不进玩家包 |
| `reframework/autorun-probe/` / `docs/evidence/` | 实验探针与历史证据，不进玩家包 |
| `sdk-dump/` | SDK 生成来源，不进玩家包 |

历史方案和评审是研究资料，不代表当前发行版所有功能均已验收。当前发行边界以玩家说明及测试说明为准。


## 最新测试包（Nightly）

[下载最新 Nightly](https://github.com/drunkenQCat/mhr-arena-roguelike/releases/tag/nightly)：选择 Assets 中的 `MHR-Arena-Roguelike-nightly.zip`，不要下载 Source code。私有仓库需要授权；朋友打不开时，请组织者直接发送同一份 ZIP。双方退出游戏后再覆盖安装，包内版本清单记录确切提交。

每天北京时间 04:00 及 Actions 手动运行构建，通过检查后更新固定 nightly 预发行版。正式版本仍通过 `v*` 标签发布，两者使用同一打包白名单，不包含研究探针、日志、测试 EXE 或构建中间文件。

游戏启动后自动打开本机控制台 `http://localhost:11777/console`。首页提供“下载测试日志”；电脑上还会列出手机访问地址和防火墙排查说明，手机端隐藏连接提示。联网朋友各自使用自己电脑的控制台，只有手机控制需要与自己的电脑处于同一局域网。

请按[两人测试步骤](docs/tester-guide.md)先验单怪入场，再测顺序／同时双怪。任务入场、局内状态与出怪确认屏障已接线，本机双引擎回归已通过，跨电脑官方 Steam 仍待验收。局内选波由房主负责，购物在每人自己的控制台操作。协议和边界见[联机运行说明](docs/multiplayer-runtime.md)。
