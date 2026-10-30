# 框架迁移与 CLI 博客：代码核对记录（2026-10-30）

本文服务于博客 Issue 8 的技术重写。只读核对旧项目、上游源码、本地 REFramework fork 与现有 CLI；未修改游戏代码或操作游戏。

## 结论

SPL 适合给 MHW 已封装能力编写 C# 插件，并不禁止调用库外函数；它也有 DTI、原生调用／hook、地址扫描缓存和程序集热重载。REFramework 对本项目更有价值的差异，是对 RE Engine 类型数据库提供统一的类型、方法、字段发现及调用接口，让 Agent 可按名字进行更大范围的探索。两者都仍须逆向确认资源加载、对象生命周期、状态机与线程约束。

给 SPL 加 HTTP／CLI 是可行且值得考虑的替代方案。旧项目已经有 ASP.NET 模拟服务，但它只操作 RunCore，不是游戏桥。把请求排入游戏回调线程、加状态与回执，可改善 UI 与复测体验；不能由此推断尚未查明的首领生成流程就会自动解决。没有实施两框架同条件对照实验，不能宣称速度或完成度的定量优势。

## 可核对的代码依据

| 论点 | 代码／记录 | 证明及边界 |
|---|---|---|
| 旧项目使用 SPL 2.0.0／.NET 8 | `../mhw-moddev/src/MhwRogue/MhwRogue.csproj` | 固定包版本与目标框架；不等于完全没有引擎元数据 |
| SPL 地址仓库来自模式扫描及版本缓存 | 上游 `mhw-cs-plugin-loader/AddressRepository.cpp`；`SharpPluginLoader.Core/Memory/AddressRepository.cs` | 读取 `AddressRecords.json`，校验游戏 revision／记录 hash，扫描并缓存；按名字取不到地址会抛异常 |
| SPL 核心包装中存在具体字段偏移与已知函数签名 | 上游 `SharpPluginLoader.Core/UnitManager.cs` | `LineCount` 使用 `0x3E38`，`AddTopFunc` 使用 `AddressRepository.Get("UnitManager:AddTop")` 和明确 NativeFunction 泛型签名 |
| SPL 有 RTTI／类型构造，不应写成完全盲扫 | 上游 `SharpPluginLoader.Core/MtDti.cs` | 类型名、继承层次、大小、构造入口、按名称找 DTI；不能与 REFramework 的通用方法／字段调用表混为一谈 |
| 库外函数可以自行调用／hook | 旧项目 `ref/spl-docs/CallingNativeFuncs.md`、`FunctionHooking.md`；官方对应文档 | 地址、签名及 marshalling 需要作者提供；不必等待 SPL 作者加入封装 |
| SPL 已有程序集热重载 | 上游 `SharpPluginLoader.Core/PluginManager.cs` | FileSystemWatcher 监控 DLL 变更，调用 ReloadPlugin；不能把热重载说成 REFramework 独有 |
| 旧项目的生成 API 尚缺完整业务协议 | `../mhw-moddev/src/MhwRogue/Wave/SpawnProbe.cs`、`WaveTableInjector.cs`、`data/addresses.421810.map` | NewUnit/AddTop 尝试；后续转向任务表，候选偏移尚待确认。对象构造／挂入 line 不等于首领完整加载流程 |
| 旧项目有可复用社区经验 | `../mhw-moddev/docs/spl-mod-survey.md`；`ref/spl-examples/` | DPS 统计、动画查看器、自定义动作与网络包等。不能声称 MHW 社区没有复杂程序性 mod；准确表述是未找到满足本项目完整肉鸽需求的可复用闭环 |
| 旧项目已经有 HTTP 模拟器 | `../mhw-moddev/src/MhwRogue.SimServer/Program.cs` | ASP.NET 路由调用 RunCore；不连接游戏对象，不能当成真实游戏 CLI 已实现 |
| 混合分辨率屏幕上的模糊 | 用户亲历；旧项目 `Ui/ChineseFont.cs` 和 `NO_IMGUI` 构建记录 | 上游 D3DModule.cpp 实际调用 EnableDpiAwareness，并传递 swapchain viewport／窗口尺寸；默认字体含固定 16/18px。仅为排查线索，不能据此确定模糊根因 |
| 一次旧项目崩溃是插件自身签名错误 | `../mhw-moddev/docs/agent-session-log.md`，2026-10-12 17:58 | OnQuestEnter() 与 OnQuestEnter(int) 不匹配；不能算作 SPL 架构缺陷 |
| REFramework 提供统一反射入口 | `../REFramework/src/mods/bindings/Sdk.cpp` | 暴露 find_type_definition／get_managed_singleton、get_methods／get_fields 等。类型信息不证明任意调用条件正确，也不是还原游戏源码 |
| Lua 不是完整网络运行环境 | `../REFramework/src/mods/ScriptRunner.cpp:122`，Lua 官方手册第 6 章 | 显式加载部分标准库、限制 os 部分能力；Lua 标准库本就不含 HTTP／WebSocket。准确说法是未捆绑可直接使用的网络服务栈，不是把 Lua 标准 HTTP 库删掉 |
| 原生 HTTP 与 Lua 协同 | `native/webconsole/src/plugin_main.cpp`、`lua_bridge.cpp`、`memory_bridge.h`、`http_server.cpp` | HTTP 线程只处理通信，Lua 帧回调取命令执行并发布快照；通过 on_lua_state_created 注册 package.preload，不让 HTTP 线程直接操作游戏对象 |
| CLI 是现有后端的另一个客户端 | `cli/mhr.mjs`、`cli/lib/game-entry.mjs`、`src/game/webconsole_bridge.ts` | CLI／Vue 共用协议；入场按真实 UI 状态、token、回执前进，拒绝未知窗口；不是固定延时乱按 |
| fork 新增三项插件 API | REFramework `9e06c96`、`25d0aef`、`2e7ce5b` | reset 用 atomic 请求；run_script 用 mutex 保护的队列；on_frame 消费。last_script_error 通过 shared_mutex 复制至调用者缓冲区。新增函数指针追加到表尾 |
| 执行脚本不等于重载脚本 | 同上 ScriptRunner.cpp | run_script 在现有主 Lua state 运行并登记；可以做小探针，不代表会自动撤销已有回调／hook。完整清理仍须 reset 或显式生命周期管理 |

## 固定版本与公开链接

SPL 源码核对版本：`c16380a398c3252309ba94d1c154ad58f6ab5413`（公开 master 快照）；旧项目实际包为 2.0.0。公开源码比对用于证明架构机制，不声称与历史安装包逐字节一致。

- [SPL 地址扫描实现](https://github.com/Fexty12573/SharpPluginLoader/blob/c16380a398c3252309ba94d1c154ad58f6ab5413/mhw-cs-plugin-loader/AddressRepository.cpp)
- [SPL UnitManager](https://github.com/Fexty12573/SharpPluginLoader/blob/c16380a398c3252309ba94d1c154ad58f6ab5413/SharpPluginLoader.Core/UnitManager.cs)
- [SPL PluginManager](https://github.com/Fexty12573/SharpPluginLoader/blob/c16380a398c3252309ba94d1c154ad58f6ab5413/SharpPluginLoader.Core/PluginManager.cs)
- [SPL D3D／字体与 DPI](https://github.com/Fexty12573/SharpPluginLoader/blob/c16380a398c3252309ba94d1c154ad58f6ab5413/mhw-cs-plugin-loader/D3DModule.cpp)
- [REFramework SDK](https://cursey.github.io/reframework-book/api/sdk.html)
- [本地 fork 的 ScriptRunner](https://github.com/drunkenQCat/REFramework/blob/2e7ce5b97dce68cc742b5c80ad421213c551c803/src/mods/ScriptRunner.cpp)
- [ReaPy](https://github.com/RomeoDespres/reapy)：Python 对 REAPER ReaScript Python API 的包装；借鉴的是外部请求转入宿主循环的方式，不是 Lua HTTP 代码移植。

## 博客采用的主线

朋友委托／原定 World → SPL 能力边界与数周探索 → 多屏 ImGui 的个人痛点 → 迁移 Rise 与 REFramework → Computer Use 不会 WASD／生成式 ImGui 交互慢和卡住 → 受 ReaPy 启发先做网页后端 → 嵌入式 Lua 未配网络栈，改做原生 HTTP 插件 → Vue 与 CLI 共用后端 → 根据真实 UI 状态编排行为进入游戏 → fork 增加 reset → 进一步加 run-script 与 last-error → 探针执行、报错及复测闭环。
