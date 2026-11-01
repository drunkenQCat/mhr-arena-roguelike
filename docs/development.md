# 开发、探针与发行维护

本页命令默认在仓库根目录执行。玩家不需要这些工具，安装操作见 [玩家使用说明](player-guide.md)。

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
node cli/mhr.mjs game run-script reframework/autorun-probe/probe_playtest_snapshot.lua --json
```

本地 Lua 文件存在时 CLI 上传内容并包装 executionId；只有对应执行的 report 才作为本次结果。运行前审查脚本是否只读、是否注册持续回调。新的诊断优先写一次性读数与有界输出，不注册每帧大快照、不反复重写历史文件。运行有写入效果的研究脚本必须明确目标任务与验收步骤。

独立模块往返/GC 探针源文件仍在 `reframework/autorun/lua/webconsole_probe.lua`，其 auto 入口保留用于开发验证，不进发行包。doctor 的业务健康检查不依赖该探针，`/api/probe/report` 也可供一次性脚本发布结果。

## 打包

白名单为 `scripts/release-files.json`；不要使用递归拷贝 autorun、framework/scripts、docs、dist 或整个工作区的打包方式。构建的 Lua 和单 HTML 必须打进运行包，但源码仓库继续忽略它们，不能为了发布再提交二进制或 dist。

打包前按 `.github/workflows/release.yml` 构建。FrameworkDirectory 指向固定 commit 的源码，已构建出 `build/bin/MHRISE/dinput8.dll`。仓库根的 package-release.ps1 是本地和 CI 共用入口，必须选择全新/空暂存目录及不存在的 ZIP 路径；不再自动删除任意暂存路径。

生成后自动运行 check-release.ps1，检查每个 ZIP 路径均属于白名单，manifest 列表、大小与 SHA256 对应，没有额外脚本/日志/编译中间文件。第三方许可随包保留。旧 q900101 JSON 不属于现用动态任务900102的必需文件，不打包；本版也不分发其它游戏和VR脚本/可选VR加载库。

手动 GitHub Actions workflow_dispatch 只构建上传 artifact，方便先下载验收。v* tag 才发布 Release。不要为检查包内容反复改标签；先完成 ZIP 与干净安装验收，再准备标签。工作区未提交内容不由 git commit 标识覆盖，不能将本地包当作已完成 CI 发布。

## 发行前检查

1. 构建和检查均通过，从最终 ZIP（而非开发机已有目录）检查清单。
2. 首次安装、更新安装、旧探针残留三种场景分别检查；不能静默删除用户其它模组。
3. 不带探针时网页/doctor 不误报整体失败；帮助页 `/api/connection` 正常。
4. 电脑与手机页面可用，手机地址包含端口。多网卡/无网卡返回值均可理解。
5. 完成单人一层、购物、结束、原生结算和恢复链；记录仍未验收项，不能把 mock 当真实多人。
6. Release 附使用说明、测试反馈模板和 build-manifest；确认没有存档、恢复 journal、IP 快照或本机日志。

当前恢复/多人等评审问题未因打包整理自动修复，见对应 review 文档。发行文字必须保持单人测试版定位。


联机入场实验以《测试与反馈》为准，完整多人肉鸽未实现。CI 可复用 REFramework fork 的固定成功构建 40834594055（commit 2e7ce5b97dce68cc742b5c80ad421213c551c803）；同时核对产物 revision 和 dinput8.dll SHA256 BCB318D59FAA28B979BE26460CA8DF815D602197E2605DC6D90E4AAF1AEEDB15。下载失败、过期、权限或哈希不符时回退从固定源码构建，绝不采用浮动 latest 二进制。
