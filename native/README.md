# Native webconsole 构建

当前插件面向 Windows x64。安装 Visual Studio 或独立 Build Tools 的 **Desktop development with C++**（C++20 编译器和 Windows SDK），并安装 CMake 3.20 或更新版本。不依赖特定安装盘、VS 年份/版本或 SDK 版本。

从仓库根目录运行（也可从其他目录通过完整路径运行）：

```powershell
# Release DLL
.\native\webconsole\build.ps1

# Release 独立 HTTP 服务，用于不启动游戏的测试
.\native\webconsole\build.ps1 -Target Standalone

# Debug 独立 HTTP 服务
.\native\webconsole\build.ps1 -Target Standalone -Configuration Debug
```

构建统一使用 `webconsole/build.ps1` 的 `Target` 和 `Configuration` 参数：通过 PATH 或 Visual Studio Installer 中的 `vswhere.exe` 发现包含 x64 C++ 工具的最新安装（包含 Build Tools），由 CMake 配置编译器、链接器及 SDK。找不到 vswhere 时可使用已有 `VSINSTALLDIR`。缺失工具链或编译失败会返回失败，不继续部署。

默认最终文件仍输出到 `native/webconsole/`，兼容现有部署和联调脚本；对象、导入库、符号和 map 写到 `.build/<Target>-<Configuration>-x64/`。这些产物都由 `.gitignore` 排除。构建脚本本身不部署文件、不关闭游戏。

可以直接传参数：

```powershell
.\native\webconsole\build.ps1 -Target Plugin -Configuration Debug -OutputDirectory .\.local\native-output
.\native\webconsole\build.ps1 -Target Standalone -VisualStudioPath 'D:\VS\BuildTools'
.\native\webconsole\build.ps1 -VsWherePath 'D:\tools\vswhere.exe'
```

自定义输出目录以调用者当前目录为基准；标准部署脚本仍从默认输出目录读取。输出 DLL 被游戏加载时需先退出游戏再重新构建。

支持 Windows PowerShell 5.1 和 PowerShell 7。若执行策略阻止脚本，可对单次调用使用 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\native\webconsole\build.ps1`，无需修改机器执行策略。仓库不再维护 BAT 包装入口；CMake 管理 Lua 静态库、插件和独立测试目标。

## 独立测试

```powershell
.\native\webconsole\test-server.ps1
.\native\webconsole\test-server.ps1 -HealthOnly
.\native\webconsole\test-server.ps1 -Configuration Debug -ObserveSeconds 2
```

测试自动选择空闲端口，使用系统临时目录中的独立服务副本、网页和 JSON 样本，不改仓库 testdata、不连接游戏端口。完整测试校验 health、状态/结果/配置/网页和命令信箱；结束时停止自己启动的进程，错误向调用方传播，临时文件和 stdout/stderr 路径会打印出来以便排查。

测试统一使用 `test-server.ps1`：可通过 `-Port 11880` 指定端口（占用则失败），通过 `-BinaryDirectory 'D:\output'` 指定构建产物目录，或通过 `-ObserveSeconds 5` 增加存活观察时间。

工具链发现依据：[Microsoft vswhere](https://github.com/microsoft/vswhere)、[Microsoft C++ 命令行环境说明](https://learn.microsoft.com/en-us/cpp/build/building-on-the-command-line)。

## 第三方依赖

REFramework 的 `API.h` 随源码固定版本分发，来源、提交、校验值和修改记录见 [依赖说明](webconsole/reframework/README.md)，完整上游 MIT 许可证见 [LICENSE](webconsole/reframework/LICENSE)。发布插件时应将该许可证纳入第三方声明；更新头文件需重新验证加载及 ABI 兼容性。


### cpp-httplib

`webconsole/httplib.h` 来自 [yhirose/cpp-httplib](https://github.com/yhirose/cpp-httplib)，用于原生插件的 HTTP 服务，采用 MIT 许可证。头文件保留其版权声明 `Copyright (c) 2026 Yuji Hirose. All rights reserved.`。

当前文件的版本宏为 `0.63.0`，但内容与上游 `v0.63.0` 标签存在差异；确切上游提交及差异来源尚未确认，因此不声明为该标签的未修改副本。本次仅补依赖说明，不替换头文件。

MIT 允许使用、修改及再分发，需保留版权与许可声明。分发源码或插件时，请随包携带本节完整声明（也可收录到第三方许可证文件）；仅提供上游链接不足以代替许可文本。此处使用 MIT 不代表本项目自身已选择 MIT 许可证。

以下为[上游完整许可文本](https://github.com/yhirose/cpp-httplib/blob/master/LICENSE)：

```text
The MIT License (MIT)

Copyright (c) 2017 yhirose

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```


## 内存桥与宿主探针（0.3.3）

插件在 REFramework 的 Lua-created 回调中注册 `package.preload.webconsole`。`require("webconsole")` 使用已经加载的同一插件实例，不需要将 DLL 另拷到 autorun，不依赖 plugins 目录出现在 package.cpath 中。

每个 Lua 环境创建时递增 epoch，并清空旧代命令/状态/结果/探针缓存。DLL session 标识进程中的插件，Lua epoch 区分连续 Reset；不能用进程 session 去重所有加载记录。HTTP 线程和 Lua 共享同一 MemoryBridge；常规命令、结果、状态不再经过文件信箱。配置保存和每次探针的一份证据文件仍会写盘。

自动探针验证字符串（含 NUL/UTF-8）及 GC 后往返；网页直接读取 `/api/probe/report`，不以业务 stateSeq>0 作为探针展示条件。Reset 后旧报告不得继续展示为当前 PASS。

原生生命周期测试（独立 Lua 环境，不能替代游戏内 Reset）：

```powershell
cmake --build native/webconsole/.build/Plugin-Release-x64 --config Release --target bridge_lifecycle_test
ctest --test-dir native/webconsole/.build/Plugin-Release-x64 -C Release --output-on-failure
```

测试使用实际编译的 Lua C API/桥接函数，覆盖三个 Lua 环境的创建/销毁、preload、GC、错误参数、队列上限、同一存储实例及旧代清理。Lua 源码已逐文件核对：61 个文件与 REFramework `5bae4701396248a776c1de19f5be9552022295d5` 中的 `dependencies/lua/src` 一致（归一化 CRLF）。原始版权与完整许可文本保留在 `lua54/lua.h` 末尾；分发时需保留对应许可声明。

原来的 `scripts/review-webconsole.py` 使用文件信箱的隔离联调机制，尚未适配新内存后端，不能据此验收此版本；当前使用原生 CTest、Lua 探针语义检查和真实游戏 HTTP 回执验证。


## 联机配置通道（0.4.2）

配置通过独立 Steam 大厅键传输，不占用波次计划或出怪 ACK。Lua 模块新增 `steam_config_payload(lobby, text)`、`steam_config_control(lobby, text)`、`steam_config_ack(lobby, text)`；`steam_snapshot()` 在各大厅的 `config` 中返回 `control / payload / digest / complete`，成员增加 `configAck`。没有增加 HTTP 路由；网页和 CLI 仍提交通用业务命令，由宿主 Lua 线程执行。

载荷上限 65536 字节，先编码为 ASCII Base64，再按1800字节分块（最多49块）；最后发布包含块数、原文字节数和 SHA256 的 manifest。读取端核对全部长度与完整摘要，缺块、混合旧块或损坏时不返回可用载荷。控制帧与成员 ACK 各限2048字节。只有房主可写载荷和控制帧，各成员只写自己的 ACK；返回 true 仅表示本地提交，业务层必须等固定名册逐端确认。权限与异步更新依据 [SetLobbyData](https://partner.steamgames.com/doc/api/ISteamMatchmaking#SetLobbyData) 和 [SetLobbyMemberData](https://partner.steamgames.com/doc/api/ISteamMatchmaking#SetLobbyMemberData)。

`write_config(name, text)` 只接受 `mhw_rogue_config.json` 与 `mhw_rogue_config_pending.json`，上限256 KiB，与装备/物资恢复文件隔离。它复用完整写入、刷新、关闭和原子替换的文件原语；Lua 仍精确读回。未完成的配置事务在下次装载前恢复旧方案；损坏的恢复记录会阻止开局与覆盖配置，但继续运行个人原装恢复；默认值仅用于恢复协调器，不作为可游玩方案返回给策划。DLL 更新需退出并重启游戏。

原生 CTest 覆盖 UTF-8/最大载荷、缺块/错块、部分写入失败、房主权限、独立 ACK、配置文件名边界与 Lua API 参数。编译后的 Lua harness 另测四端屏障和缺 ACK：不能先把缺失 ACK 映射为数组中的 null，否则 Lua nil 空洞可能使遍历跳过队友。

## 通用业务信箱（0.4.3）

新增 Lua API：`steam_subscribe(channel)`、`steam_lobby_message(lobby, channel, text)`、
`steam_member_message(lobby, channel, text)`。订阅后，`steam_snapshot()` 的大厅及成员
记录通过 `messages[channel]` 返回相应值。它们与已有计划、ACK、配置通道使用独立键，
没有为每种业务增加 HTTP 路由，也不向原生聊天处理器注入消息。

频道名称为1至24个小写字母、数字、`_`、`.`或`-`，首字符必须是字母或数字。
每个插件实例最多订阅8个频道，重复订阅幂等；单条值最多2048字节且不能含 NUL。
只能在已观察到且本机仍为成员的大厅操作；大厅值仅房主可写，成员值只能写自己。
权限来自原生 Steam 身份，不能使用消息正文里的自称身份替代。DLL 更新需重启游戏。

返回 `true` 只表示本地提交，不能当作对端收到、更不能当作商品交付成功。
`PeerMailbox` 使用序号、脚本代数、载荷摘要和准确回执确认处理丢失与重复；
固定名册或房主变化即停止接纳。`EffectAuthority` 另行持久化全队名额与冻结许可，
购买者仍在自己的引擎里核验原生写入和扣款。恢复旧授权记录不自动重放许可。
`EffectParticipant` 已将其接入商品预订、原生交付回执和全员开战屏障。
同机双引擎验收与尚未覆盖的范围见 [效果实验记录](../docs/designer-effects.md)。
纯协议测试不替代原生验收；官方 Steam 跨电脑与3／4人新效果事务仍待验证。

Steam 的[大厅数据接口](https://partner.steamgames.com/doc/api/ISteamMatchmaking)
使用异步缓存更新；因此协议必须处理延迟、陈旧值与回执，而不能把键值更新当作可靠队列。
原生 CTest 覆盖权限、大小、频道隔离和 Lua 生命周期；`npm run check:effects`
执行实际编译 Lua 的两端丢包模拟。两者均不能替代两个 Rise 引擎的实机验收。

## 同机多个实例的后端端口

每个游戏副本使用独立的 `reframework/data` 目录。在该副本的
`reframework/plugins/webconsole.ini` 中写入：

```ini
[webconsole]
port=11778
openBrowser=0
```

默认端口仍为 11777，默认自动打开网页。端口必须为 1–65535 的十进制整数；
非法配置会拒绝启动插件 HTTP 服务。环境变量 `MHR_WEBCONSOLE_PORT`、
`MHR_WEBCONSOLE_OPEN_BROWSER`（0/1）分别覆盖 INI。同机两份副本应使用不同端口，
重启游戏后生效；这只隔离后端服务，不提供第二个 Steam 身份或多人游戏能力。

## 跨进程协议回归

```powershell
npm run build:nocopy
python -m pip install lupa==2.8
python scripts/check-multiplayer-process.py --report .local/dual-process-results.json
```

脚本启动两个独立 Python/Lua 5.4 进程，加载实际编译 Lua，经本机 HTTP 中转模拟
Steam lobby 元数据。覆盖选波权限、私人 PT、登记/确认/提交/激活、奖励去重和冻结队友。
原生读数为替身，不能替代两个 Rise 引擎的入场、怪物同步或伤害验证。CI 必须通过此项。
