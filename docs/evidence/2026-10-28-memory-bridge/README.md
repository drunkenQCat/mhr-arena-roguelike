# 76749f1 审查、修复与实机验证

## 原问题（真实游戏复现）

启动提交 76749f1 部署的 DLL 0.3.2 后，HTTP 正常，但 `/api/probe` 为 sessions=0、pings=0、stateSeq=0；state/report 为 503。REFramework 日志明确记录 require("webconsole") 找不到模块，搜索 autorun 而没有 plugins。入口加载探针成功不等于探针测试成功。

另有以下代码问题：

- json.dump_string 实际是 `(object, indent)`，探针传了 `(nil, document, 2)`，报告在实机写成 `null`。harness 的错误签名与产品代码相互掩盖。
- 用跨 Reset 不变的 DLL session 去重历史，会删除同进程内不同 Lua 加载代；原三次 Reset 测试没有模拟这一真实身份关系。
- 网页以业务 stateSeq>0 为条件才读取独立探针，独立探针已完成但业务桥失败时仍不展示；跨 Reset 还可能保留旧 PASS。
- TS 只有 `declare const webconsole_bridge`，没有 require；实际命令/状态/结果仍走旧文件，HTTP 已改读内存，两个端点无法互通。
- Debug 构建使用不存在的 webconsole_dbg CMake target，且查找 Release 子目录；DLL 部署失败没有非零退出码。

## 修复

- 0.3.3 在框架 Lua-created 回调注册 package.preload.webconsole，require 使用已加载的同一插件实例，不复制第二个 DLL。共用 attach_lua_bridge 函数供实际插件和原生生命周期测试调用。
- DLL session + Lua epoch 区分进程及脚本代；创建新代清空旧命令/状态/结果/探针，销毁时失效缓存。
- 使用真实 dump_string 签名；harness 同步修正，增加同一 DLL、递增 epoch 的 Reset 场景；探针不再重设共享 RNG 种子。
- 网页直接读取探针报告，校验当前 DLL session/epoch，串行化读取避免重叠响应，代切换立即清掉旧报告。
- SDK 内显式 require 外部模块，TSTL noResolvePaths 指定 webconsole；业务桥通过内存收命令、发布状态与回执。配置保存仍落盘，传输失败不重复执行已记账命令。插件缺失不阻断核心游戏业务启动。
- 修复 Debug target/输出查找，CMake 明确选中 VS instance 和 x64，使用新的 x64 构建目录避免混入旧平台 cache；构建产物仍忽略。部署失败返回非零，最终部署后核对 DLL SHA256。

## 验证

真实 Rise 最终进程 PID 30880，DLL 0.3.3：

- `/api/probe/report` 为 PASS；42 字节（NUL/二进制/UTF-8）往返、GC 后 51 字节往返通过。Lua epoch=1，报告 DLL session 与原生端点匹配。
- HTTP→内存→Lua→结果：getConfig applied；旧 bridgeId rejected；重复 requestId 返回原回执；队列清空。未修改角色、配置、PT 或任务。
- 状态心跳递增，观察 2.2 秒内旧 cmd/state/results 文件 mtime 未变化；这是传输不再走文件的证据，不是游戏帧时间性能验收。
- 原生 CTest 使用实际 Lua 静态库和 C 模块函数，三个 Lua 环境连续创建/销毁通过 preload、binary echo、GC、错误参数、同一存储实例、旧代清理与队列上限测试。不是 REFramework Reset 按钮的实机测试。
- 140 条 Vitest、根类型检查、TSTL/Lua 语法与 Lua 5.4 runtime 检查、Vue 单 HTML 构建、探针语义和 DLL 导出检查通过。
- Debug standalone 构建及 HTTP smoke test 通过。61 个 vendored Lua 文件与宿主固定提交的源码逐个 hash 比较一致（换行归一化）。

原始证据：`native-probe.json`、`lua-report.json`、`commands.json`、`telemetry-io.json`。游戏保持开启。

## 尚未验收

当前工具无法点击原生游戏窗口，**尚未在真实游戏内连续点击 Reset scripts**；不能以独立 CTest 的三个 Lua 环境替代这个结论。也未执行选档、战斗清波、购买或长局稳定性验收。旧文件信箱浏览器联调脚本 `scripts/review-webconsole.py` 尚未适配内存后端，不作为此版本的验证依据。

## 后续实机补验：连续 Reset 通过

用户执行 Reset 后再次只读核验：同一进程 PID 30880、DLL session `30880-403530972` 内，Lua epoch 从 1 连续递增至 8，即初次加载加 7 次 Reset。8 代报告均 PASS，每代字符串往返及 GC 后往返两个检查均通过（共 16 项）。最新业务 bridgeId 以 `8-` 开头，心跳继续递增，命令队列为空；没有把旧代报告当成新代结果。

证据保存为 `live-reset-8-generations.json`。因此上节“真实游戏连续 Reset 尚未验收”的状态已解除；这仍不是长局稳定性或所有业务动作的完整验收。日志里的渲染 `on_device_reset` 不计作 Lua Reset 次数。
