# 交接：内存桥与可通过 CLI 验证的游戏控制面

这是实施任务书，端点和命令名称是建议契约，不代表当前已实现。目标是保留 Vue、Core、Session 和交易规则，把 DLL/Lua 文件通信换成有界内存通信，并让 CLI 覆盖常见实机验证；先完成一条可验收的路径，再扩充能力。

## 已有能力与资料

- `native/webconsole/webconsole.cpp`：HTTP、网页分发、当前文件信箱。
- `native/webconsole/reframework/API.h`：固定上游提交 `5bae4701396248a776c1de19f5be9552022295d5`；有 `on_lua_state_created` / `on_lua_state_destroyed` / `lock_lua` / `unlock_lua`，但没有完整的 Lua C API 函数表。
- `src/game/webconsole_bridge.ts`：现有命令校验、状态快照、配置提交、请求去重和交易最终回执。先抽出 transport 接口，不重写业务。
- `src/core/run_session.ts`：任务身份、波次及整备状态权威。`src/game/shop_window.ts`：原生和网页购买共用资格与交付规则，保留补满、猫车恢复和 uncertain 锁。
- [固定版本插件 API](https://github.com/praydog/REFramework/blob/5bae4701396248a776c1de19f5be9552022295d5/include/reframework/API.h)、[固定版本 ScriptRunner](https://github.com/praydog/REFramework/blob/5bae4701396248a776c1de19f5be9552022295d5/src/mods/ScriptRunner.cpp)、[官方插件说明](https://github.com/praydog/REFramework/wiki#plugins)。新版本示例不能代替本机 ABI 验证。
- ReaPy 的 [宿主循环](https://github.com/RomeoDespres/reapy/blob/master/reapy/reascripts/activate_reapy_server.py)、[socket 服务](https://github.com/RomeoDespres/reapy/blob/master/reapy/tools/network/server.py)、[HTTP 引导](https://github.com/RomeoDespres/reapy/blob/master/reapy/tools/network/web_interface.py)：参考外部请求由宿主回调执行的分工，不照搬其阻塞等待及函数反序列化协议。
- 当前 `sdk-dump` 不足以证明标题、选档、弹窗接口已掌握；需运行时反射和实际 UI 状态核验，记录接口签名及证据。

## 一、先证明 DLL 与宿主 Lua 能安全互通

1. 先做 spike：DLL 暴露一个窄接口，Lua 调用 `ping`，传入字符串并返回原值；Reset scripts 后重新握手，连续重复验证。
2. 必须核实 Lua 版本、编译选项、实际 C API 来源及创建/销毁顺序。只有 `lua_State*` 回调不等于可以直接调用 Lua C API；游戏 EXE 没导出 `lua_*` 也不等于框架 DLL 没有可用接口。
3. 优先调查框架支持的原生模块/插件接入方式和框架模块的导出。若需要按同版本 Lua 编译绑定，必须先从该框架版本构建配置和官方用法证明 ABI 兼容，不能凭版本号相同就操作宿主 state，不能随意嵌入另一台 Lua VM 并当作同一个。
4. 若固定安装版本确实缺接口，给出具体符号/构建证据，再提出最小框架扩展或明确的升级选择；不要静默退回文件却宣称完成内存桥。

最小 Lua 接口建议只接受/返回普通字符串和计数：`open_session()`、`take_commands(maxCount)`、`publish_state(json)`、`complete(requestId, json)`、`close_session(epoch)`。注册时机和命名按已验证接入方式调整。JSON 先保留，仅移除磁盘传输，便于复用协议。

## 二、传输与生命周期

```text
Vue 或 CLI → HTTP → DLL 有界命令队列
                          ↓ Lua 在游戏回调中取出
                    既有命令/交易/Session
                          ↓ 发布普通 JSON
HTTP ← DLL 缓存快照、事件和结果表
```

- HTTP 线程只碰普通数据和队列，不访问 Lua state、托管对象或游戏 SDK。Lua 在游戏回调中拉取，完成游戏操作后发布。
- 队列同时限制命令数和字节数（初值可设 64 条/1 MiB，单配置仍限 256 KiB），满时明确 429/503，绝不覆盖已接收请求。慢客户端不阻塞游戏线程。
- 队列锁内只移动/交换数据，不执行游戏调用、JSON 解析或网络发送；不得持有队列锁再获取 Lua 锁。Lua 销毁时不得继续触碰旧 state。
- 维护进程 bootId、Lua epoch/bridgeId、questUnique、waveToken、configVersion。Reset 清除旧代未执行命令，旧请求返回 session_changed；曾进入原生写入但未确认的交易仍为 uncertain。
- requestId 按 Lua 代去重；相同 ID 不同请求体应拒绝。多个浏览器/CLI 同时提交也共用去重和串行 mutation 调度，不只靠前端 busy。
- 结果保留有界 TTL/数量；过期与未知要区分。不能声称跨进程崩溃 exactly-once。
- 回调命令按数量与时间预算处理，长操作变成跨帧 job；HTTP 不同步等待几十秒的任务流程。轮询、事件发送频率与游戏采样解耦。
- 状态缓存附 sampledAt、sequence、epoch、staleReason；DLL 存活与 Lua 可执行分开显示。SSE 可后加，第一版保留现有 HTTP 轮询。
- 删除遥测/命令路径对 `webconsole_cmd/state/results.json` 的依赖。配置保存、预设导出和按需证据仍可落盘；未连接客户端时也不要持续归档遥测。
- 第一版保持 `/api/state`、`/api/command`、`/api/results` 兼容，新增资源可并行提供。先让原 Vue 不改业务就能工作。

## 三、CLI 分成电脑侧与游戏侧

CLI 可用现有 Node 生态实现，无需新增常驻 Node 服务。电脑侧负责 Steam/游戏进程启动、退出、日志与服务探测；只有游戏插件加载后才能调用游戏端点。启动命令显式运行，不在 status/doctor 时自动启动。

建议命令统一支持 `--base-url`、`--json`、`--timeout`；正常数据输出 stdout，进度/诊断输出 stderr，明确退出码。`wait` 根据状态/事件和 deadline 等待，不以固定 sleep 推断成功；超时输出最后状态与阻塞条件。启动返回 PID 不算进入游戏成功。

```powershell
node cli/mhr.mjs doctor --json
node cli/mhr.mjs game launch
node cli/mhr.mjs wait --scene title --timeout 120
node cli/mhr.mjs ui inspect --json
node cli/mhr.mjs saves list --json
node cli/mhr.mjs saves load --slot 1
node cli/mhr.mjs wait --scene village --timeout 120
```

这是目标用法，先调查选档接口，禁止为了跑通流程写死按键延时。

## 四、观测端点优先

| 建议端点 | 需要返回的内容 |
| --- | --- |
| `GET /api/health` | DLL 版本、协议版本、bootId、传输方式；不假装 Lua ready |
| `GET /api/capabilities` | 各能力 implemented/supported/enabled/allowed 与拒绝原因；未实现返回 unsupported |
| `GET /api/runtime` | Lua epoch、ready、游戏版本、主循环/采样心跳、队列长度、延迟、最近错误、是否暂停/失焦 |
| `GET /api/ui` | title/save_select/loading/village/camp/quest/results/unknown、顶层 UI、阻塞弹窗栈、忙状态、输入归属、可操作项和证据来源 |
| `GET /api/saves` | 实际存档槽、是否存在、显示名/进度等必要摘要、选中槽和可加载性；不暴露整个存档文件 |
| `GET /api/player` | 实际角色身份、位置/区域/营地/地图、HP、猫车、加载状态；不可读返回 unknown |
| `GET /api/quest` | 实际任务/实例、开始/完成/失败、计时、加载阶段、回村/结果进度 |
| `GET /api/wave` | 计划/实际怪物 UID、种类、存活/捕获、槽位、生成阶段、基础/计划/实际倍率、奖励与清波条件 |
| `GET /api/shop` | 统一 catalogue、实际库存、购买资格和阻塞原因、未决交易；不重新实现一套资格 |
| `GET /api/operations/{id}` | queued/running/applied/rejected/uncertain/cancelled、阶段、结果及状态证据 |
| `GET /api/events?after=seq` | 有界增量事件；重置/过期游标明确返回，不能静默漏事件 |
| `GET /api/diagnostics` | 最近有界错误、队列溢出、重置数、丢弃/过期数、采样/执行耗时和 I/O 计数 |

可先将这些作为现有 state 的结构化子资源，共用同一采样快照。不要每个 GET 重读游戏对象。

UI 观测必须先区分：程序启动/插件加载、标题界面、存档选择、载入、村庄、斗技场营地、场内战斗、结算。不能靠背景画面、坐标接近起点或 QuestManager 单例存在判村庄。存在不能识别的 UI 时保留 unknown 并阻塞依赖动作。

弹窗至少探测网络不可用/重连、离线进入、DLC/公告、保存提示、退出确认、任务失败/完成、奖励确认、手柄断连。返回 dialogId、实例 token、类型、文本/消息 ID、按钮 ID/可用性、阻塞级别。优先结构化原生 UI，截图/OCR 只作辅助，不把猜测结果当成确认。

## 五、变更动作走同一异步命令入口

建议扩展 `POST /api/command` 的白名单动作，UI/存档动作额外携带 sceneToken/dialogToken，拒绝旧弹窗误确认。

| 动作组 | 建议命令及边界 |
| --- | --- |
| 标题与选档 | `title.continue`、`save.select/load`；进入指定槽后核验实际角色身份；不默认创建/覆盖/删除存档 |
| 弹窗 | `dialog.respond(dialogToken, buttonId)`；针对已识别窗口响应，未知弹窗停下输出证据；不无条件“全部确认” |
| 网络 | `network.chooseOffline`、已验证的 retry/cancel；显式离线意图，不能后台接受未知授权/付费窗口 |
| 任务流程 | `quest.post/depart/return/abort`、`results.accept`；复用已有 transport，等待原生状态变化作为完成 |
| 肉鸽 | 复用 startRun/choose/retryPost/stop/setRoute；额外提供实际清波/集结/下一层阻塞原因 |
| 战斗验证 | 显式 `setInvincible(value)`、`enemy.kill(uid)`，支持仅本波/指定 UID；定向击杀在原生死亡登记后才 applied，防止误杀保留怪 |
| 移动验证 | `player.moveToCamp` 或受控地图内传送，先验证位置设置与区域切换语义；受任务/地图限制，观测与修改分开 |
| 交易与配置 | 复用 buy/getConfig/submitConfig；携带版本、任务/波次身份；部分交付 uncertain 禁止自动重试 |
| 脚本与退出 | 可探测 reload 请求、game.exit；重载跨 epoch 的结果由电脑侧追踪，不能在回调栈里销毁自己后继续运行；退出优先原生流程 |

没有原生接口的项目应报告 unsupported 和缺少的证据，必要时另做可选 UI 输入适配层，不把 SendInput 当作每项能力的默认实现。不要提供任意 Lua eval、任意方法调用或裸内存写入 HTTP 端点。

## 六、让验证可以脚本化

- `doctor` 一次区分进程未启动、DLL 未加载、版本不匹配、Lua 未就绪、心跳冻结、弹窗阻塞和场景不符。
- `wait` 可等待 scene、dialog、questUnique、UID 出现/死亡、layer、shopAvailable、operation 终态；支持组合条件，失败返回最后证据。
- `scenario run <file>` 使用声明式步骤：命令 → 等待 → 断言 → 按需采集，不以任意脚本注入替代协议。测试失败不自动重新购买或重放不明交易。
- 测试场景：启动到指定存档进村；网络弹窗离线恢复；单怪清波后商店恢复；双怪同时在场；同种顺序波不提前奖励；购买读回；猫车恢复；Lua Reset 后旧请求拒绝。
- 断言必须比较实际观测：同场任务 unique 不变、UID 集合/同时存活、库存增量与 PT、原生死亡数和 Core 猫车数、真正倍率；仅命令返回 ok 不算通过。
- 输出机器可读报告（含版本、seed、时间、任务/波次 ID、事件片段）及可选 JUnit；大型快照/截图按需生成，不每帧写文件。
- 可选截图端点需另外验证渲染捕获方式及成本；先返回 capture unsupported，不承诺 SDK 已提供截图。
- 局域网已有手机控制：保留同源限制，增加可信配置下的配对/token 机制，CLI 从本机受限文件读取，不能把凭证写日志或提交仓库；SSE/HTTP 也需同样校验。不要因为有 sceneToken 就宣称有鉴权。

## 七、实施顺序与完成标准

1. DLL↔Lua ping + 连续 Reset 验证；记录真实 ABI 接入依据。
2. 抽 transport 并换内存队列：旧网页可用，多客户端无丢命令，清除持续通信文件 I/O，重置/队列满/异常不崩游戏。
3. CLI doctor/state/command/wait + runtime/ui 只读；列出标题、选档、弹窗接口待查清单。
4. 跑通启动→标题→选档→进村，真实网络弹窗有一次明确响应并验证消失；未知窗口可靠停下。
5. 一条游戏内完整 CLI 场景：新局→选波→出怪→定向击杀→原生清波→集结→商店购买并读回→下一层。
6. 扩展双怪/倍率/猫车/恢复场景。区分 mock、独立 DLL/Lua 联调和真实游戏，分别记录通过范围。

保持源码提交整洁：不跟踪 DLL/EXE/OBJ/MAP/日志/dist/生成 Lua/SDK。沿用 PowerShell 构建入口，补新增第三方依赖许可证。不进行大规模 UI 重写；未完成 native 接入 spike 前不要先铺满一套无法执行的端点。
