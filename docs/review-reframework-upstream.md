# REFramework 稳定版、master 与 fork 成本评估

核查日期：2026-10-28。只读调研，没有替换游戏 DLL、重启游戏或创建远端 fork。源码比较仓库放在被忽略的 `.local/reframework-upstream-review/`，不进入本项目历史。

## 比较基准

- [最新稳定 release v1.5.9.1](https://github.com/praydog/REFramework/releases/tag/v1.5.9.1)：`5bae4701396248a776c1de19f5be9552022295d5`，也是本项目安装版本和 vendored API.h 的基准。
- 默认分支是 **master**，不是 main；本次 `git ls-remote` 固定为 `d4611aef1d63effd3a736bdf9404ea702428017d`，提交时间 2026-10-20（作者时区 -07:00）。
- 两者相差 515 commits。实际 git diff 为 508 个文件、277832 行新增、55932 行删除；大量来自字体及新 .NET/生成代码，不能把行数当成全部业务改动量。

## 主要变化

1. [REFramework v2 重构 09284e2](https://github.com/praydog/REFramework/commit/09284e2)：原先按游戏编译的 SDK/DLL 改为统一 `REFrameworkSDK` 和 `REFramework` 目标，运行时检测游戏/TDB；产物为 `build/bin/REFramework/dinput8.dll`。Rise 仍在 GameIdentity 支持表内，但这不证明我们的全部 hook 已回归。
2. Plugin API 1.10.0→1.15.0：追加 GUI pre-draw 回调、模块/程序集访问、managed array 创建等。主要是尾部追加；`get_ref_count` 返回值由 unsigned 改 signed，属于 C/C++ 源码签名/语义变化，不能说完全没有 breaking change。
3. Lua 版本仍声明 5.4.3。`dependencies/lua/src` 只有 `ldebug.c`、`lvm.c` 两个文件有差异，修正错误/字符串拼接路径的栈处理；不能把官方未经修改的 5.4.3 当成 master 的精确源码。
4. Lua GC/引用计数/回调安全修复：29ed206（GC 加锁）、52f5fb3/9313e7f（heap corruption）、e181fd2（save_config 死锁）、6dd6724（回调遍历/自移除）等；增加 delegate、transform 回调、日志级别等能力。
5. SDK/渲染/对象布局大量改为运行时 dispatch；ImGui 升级到动态字体体系并引入 FreeType，原生 cimgui/ImGui 插件不能假设二进制 ABI 不变。
6. 新增 .NET/C++CLI 绑定、程序集生成、运行时编译、命名管道以及 Web API/MCP 示例。`csharp-api/test/Test/TestWebAPI.cs` 有通用对象浏览/读写/调用端点，游戏专用部分主要有 Wilds/RE9 条件分支；不能直接当作现成的 Rise CLI 后端。
7. 包含 `771e687`（MHWilds/Rise/REE USB 事件卡顿修复），以及其他游戏支持、渲染和加载器修复。升级收益真实存在，但不应把过去探针卡顿归因结论推翻为 USB 问题。

## 兼容性判断

| 范围 | 判定及项目影响 |
| --- | --- |
| 新插件运行于旧框架 | 新头文件通常声明要求 1.15，旧框架会因 minor 不足拒绝；不能只替换头文件就兼容 |
| 旧插件运行于新框架 | master PluginLoader 接受相同 major 且不高于宿主的 minor；我们旧版 HTTP 插件有被接受的依据，但未实机验证 |
| C/C++ SDK | get_ref_count 签名变化需适配；依赖内部结构/偏移的插件风险高于只调用公开 API 的插件 |
| Lua require | 新 require 重置 package.path/cpath/searchers，并限制绝对路径/父目录；自定义搜索路径、覆盖 searchers 的方案不再可靠 |
| Lua 文件访问 | fs/io 共用更严的校验，禁止读写 DLL/EXE；package.loadlib 有路径及 DLL 后缀限制。普通 data JSON 仍有对应入口，需实测 |
| 回调 | 新增 STOP 式自移除能力；返回 nil 的普通回调并未因此自动失效。Reset/锁/执行顺序变化仍需长测 |
| ImGui | 动态字体、枚举/按键及 cimgui 更新需要核验；我们纯网页界面影响较小，备用游戏 UI 和其他原生插件不能跳过测试 |
| 构建 | 旧 `MHRISE` 目标/REF_BUILD_MHRISE_SDK 等脚本不能沿用到 master；当前目标为 REFramework |

源码依据：[新 API.h](https://github.com/praydog/REFramework/blob/d4611aef1d63effd3a736bdf9404ea702428017d/include/reframework/API.h)、[PluginLoader](https://github.com/praydog/REFramework/blob/d4611aef1d63effd3a736bdf9404ea702428017d/src/mods/PluginLoader.cpp)、[FS/require 沙箱](https://github.com/praydog/REFramework/blob/d4611aef1d63effd3a736bdf9404ea702428017d/src/mods/bindings/FS.cpp)、[ScriptRunner](https://github.com/praydog/REFramework/blob/d4611aef1d63effd3a736bdf9404ea702428017d/src/mods/ScriptRunner.cpp)。

## 与内存桥直接相关的发现

稳定版已经有官方示例：`examples/example_plugin/Plugin.cpp` 在 Lua state created 回调内用 `sol::state_view` 绑定表/函数，CMake 的 example_plugin 链接同仓库 `lua` 静态库和 sol2。这比“没找到导出所以猜测重编 Lua”更有力：**不需要先升级或 fork 框架才能按官方方式验证插件内存桥。**

参考：[稳定版 example_plugin](https://github.com/praydog/REFramework/blob/5bae4701396248a776c1de19f5be9552022295d5/examples/example_plugin/Plugin.cpp)、[稳定版 cmake.toml](https://github.com/praydog/REFramework/blob/5bae4701396248a776c1de19f5be9552022295d5/cmake.toml)。仍须对当前二进制进行错误路径、GC、Reset 与退出验证；示例不等于我们的新模块已验收。

master 的 Plugin API 仍没有完整 Lua C API 函数表；单纯升级 master 不会自动解决我们要的 C API 导出/桥接问题。

## 本机条件和成本

已核实 CMake 3.31.2、VS 2022 Community 17.12、.NET SDK 8/9/10 已安装。尚未实际配置/编译完整 REFramework，因此下面是工程量估计，不是计时实测，也不保证当前编译器能直接通过所有 C++23 代码。

原生核心要求 C++23、递归子模块和 FetchContent 下载；master 额外有 FreeType。当前 CI 使用 VS 2026，但 CMakePresets 仍保留 VS 2022。根工程声明 CSharp；.NET API 是单独子工程，完整 .NET/C++CLI 绑定另需相应 VS 组件、NuGet 及 SDK，不能混同为编译原生 DLL 必须构建整个 .NET 栈。

| 路线 | 初始工作量估计 | 后续成本 |
| --- | --- | --- |
| 不 fork，沿用稳定版，按官方示例构建最小 Lua 桥 | 0.5–2 人日做到可验收 spike；不含完整 CLI | 最低，维护插件及固定依赖 |
| 稳定版固定提交上做小 fork，只增加桥接/API 函数表 | 1–3 人日完成构建、补丁及基础回归；长局另计 | 需分发自定义 dinput8、记录哈希、支持回滚及后续合并 |
| master 固定提交上做 fork 并迁移本项目 | 3–7 人日作为初始预算，若碰 Rise/其他插件回归会增加 | 同时承担 v2 迁移、自定义补丁和上游跟进 |
| 再迁入 .NET Web API/MCP 路线 | 应单独立项估算 | 新增 .NET/C++CLI/游戏程序集适配与另一套控制业务 |

首次依赖下载与全量构建需为网络、编译器补组件预留数小时窗口；不把它当成纯“改两行导出宏”。增量补丁编译通常比初次构建轻，但未测量具体时间。

如果决定 fork，建议先在外部目录按明确提交构建未修改的基线 DLL，成功后再做窄补丁；不要把 HTTP/UI/业务都塞进框架。优先在 ScriptRunner 中注册明确的桥接 API，或新增带版本号和大小的 C 函数表，避免大批裸内部导出变成永久 ABI 承诺。

回归至少覆盖：Rise 标题→选档→进村→接取→战斗→死亡/奖励→清波→下一层→退出，单怪/顺序/同时双怪、购买读回、猫车、中文 UI，以及 GC/Reset/暂停/失焦/慢客户端。旧原生插件逐个加载测试。新 DLL 和协议都要有回滚方案。

建议顺序：先按现有稳定版官方示例完成内存桥；另开独立上游升级验证。如果确实需要宿主导出稳定函数表，再从稳定提交小 fork；不把 master 大升级绑定成 CLI 和内存桥的前置条件。
