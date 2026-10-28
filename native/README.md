# Native webconsole 构建

当前插件面向 Windows x64。安装 Visual Studio 或独立 Build Tools 的 **Desktop development with C++**（C++20 编译器和 Windows SDK）。不依赖特定安装盘、VS 年份/版本或 SDK 版本。

从仓库根目录运行（也可从其他目录通过完整路径运行）：

```powershell
# Release DLL
.\native\webconsole\build.ps1

# Release 独立 HTTP 服务，用于不启动游戏的测试
.\native\webconsole\build.ps1 -Target Standalone

# Debug 独立 HTTP 服务
.\native\webconsole\build.ps1 -Target Standalone -Configuration Debug
```

构建统一使用 `webconsole/build.ps1` 的 `Target` 和 `Configuration` 参数：通过 PATH 或 Visual Studio Installer 中的 `vswhere.exe` 发现包含 x64 C++ 工具的最新安装（包含 Build Tools），由 VS 自带的 `vcvarsall.bat x64` 配置编译器、链接器及 SDK。找不到 vswhere 时可使用已有 `VSINSTALLDIR`。缺失工具链或编译失败会返回失败，不继续部署。

默认最终文件仍输出到 `native/webconsole/`，兼容现有部署和联调脚本；对象、导入库、符号和 map 写到 `.build/<Target>-<Configuration>/`。这些产物都由 `.gitignore` 排除。构建脚本本身不部署文件、不关闭游戏。

可以直接传参数：

```powershell
.\native\webconsole\build.ps1 -Target Plugin -Configuration Debug -OutputDirectory .\.local\native-output
.\native\webconsole\build.ps1 -Target Standalone -VisualStudioPath 'D:\VS\BuildTools'
.\native\webconsole\build.ps1 -VsWherePath 'D:\tools\vswhere.exe'
```

自定义输出目录以调用者当前目录为基准；标准部署脚本仍从默认输出目录读取。输出 DLL 被游戏加载时需先退出游戏再重新构建。

支持 Windows PowerShell 5.1 和 PowerShell 7。若执行策略阻止脚本，可对单次调用使用 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\native\webconsole\build.ps1`，无需修改机器执行策略。仓库不再维护 BAT 包装入口；构建内部调用 VS 的批处理初始化工具属于工具链实现。

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
