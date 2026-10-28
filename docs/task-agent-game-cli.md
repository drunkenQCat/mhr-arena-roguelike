# Agent 游戏控制 CLI 实施任务书

基线日期：2026-10-28。本文交给接手编程 Agent 执行，描述目标、现状、实施顺序和验收标准；标为“拟新增”的能力尚未实现。实施前重新核对工作区，不能把本文当作当前代码的替代品。

## 1. 要完成什么

让 Agent 从终端完成大多数日常实机验证：启动游戏、识别当前界面、加载指定存档、处理已识别的网络提示、进入村庄、启动肉鸽、选择波次、观察怪物、执行测试操作、购物、推进下一层，并输出可核验的报告。

最终希望能够运行一条场景命令，得到结构化的通过、失败或能力不支持报告。不能依靠盲点坐标、连续按确认、固定等待时间来声称完成，也不能仅凭 HTTP 200 或命令入队判断游戏操作成功。

先实现“当前游戏已经加载角色时的 CLI 闭环”，再实现“从启动到进村”。不要为了标题界面研究而阻塞已有业务能力的 CLI 化。

本文承接 [早期内存桥与 CLI 方案](plan-memory-bridge-cli.md)。早期文档包含已被实际实现替代的文件传输和 spike 计划；当前实现以源代码及 [内存桥实机证据](evidence/2026-10-28-memory-bridge/README.md) 为准。

## 2. 当前已有什么

```text
Vue 或 CLI → HTTP POST /api/command → DLL 有界内存队列
                                           ↓
                                  Lua 更新回调取出命令
                                           ↓
                              Session / Runtime / 商店执行
                                           ↓
Vue 或 CLI ← HTTP 状态/回执 ← DLL 缓存 Lua 发布的 JSON
```

DLL 已经是通用通道，不解析业务命令名。增加 Lua 命令通常只需更新业务脚本，若有网页入口再更新网页；不需要为每个业务能力增加 HTTP 路由、重编 DLL 或重启游戏。

业务源代码是 TypeScript，通过 TypeScriptToLua 生成 Lua。不要直接修改生成的 `reframework/autorun/mhw_rogue.lua`。

现有 HTTP 接口：

| 接口 | 实际用途 |
| --- | --- |
| `GET /api/health` | DLL HTTP 服务是否响应、版本及进程会话标识；不代表 Lua 就绪 |
| `GET /api/probe` | DLL 身份、Lua 代次计数、心跳发布次数、队列长度等 |
| `GET /api/probe/report` | Lua 模块往返、GC 和 Reset 探针报告；未发布时 503 |
| `GET /api/state` | 当前业务快照；Lua 未发布时 503 |
| `GET /api/results` | 当前 Lua 会话的命令回执及有限历史；未发布时 503 |
| `GET /api/config` | 磁盘上的配置覆盖文件，可能不存在；不等同当前生效配置 |
| `POST /api/command` | 通用异步命令入口，成功响应只代表入队 |
| `GET /console` | Vue 单 HTML 控制台 |

现有命令：`getConfig`、`submitConfig`、`startRun`、`choose`、`buy`、`setInvincible`、`killAll`、`retryPost`、`stop`、`setRoute`。以 `webconsole_bridge.ts` 中的实际参数、前置条件为准。补满和猫车恢复通过现有商店交易逻辑执行，不能另写一套绕过规则的 CLI 发货逻辑。

当前状态包括任务编号/实例、波次 token、层数、PT、猫车、位置与集结、怪物 UID/种类/死亡/捕获、商品与购买资格、配置版本等。当前 `sessionStage` 是肉鸽状态，**不是原生游戏界面状态**；没有任务也不等于人在村庄。

目前没有完整的标题、存档、弹窗观察与控制接口，也没有现成的通用 CLI。不要把下面的目标命令报告成现有功能。

## 3. 先读这些代码

| 路径 | 作用 |
| --- | --- |
| [http_server.cpp](../native/webconsole/src/http_server.cpp) | 当前路由、来源校验、入队及快照读取 |
| [memory_bridge.h](../native/webconsole/src/memory_bridge.h) | 队列上限、互斥、会话清理 |
| [lua_bridge.cpp](../native/webconsole/src/lua_bridge.cpp)、[plugin_main.cpp](../native/webconsole/src/plugin_main.cpp) | 模块注册、Lua 生命周期和 C 接口 |
| [webconsole_bridge.ts](../src/game/webconsole_bridge.ts) | 业务命令执行、身份校验、去重和回执 |
| [api.ts](../console/src/api.ts) | 网页的命令封装、心跳判断和回执等待；包含需修正的旧文件传输注释，不能照抄其全部完成判据 |
| [sdk.ts](../src/game/sdk.ts) | REFramework API 边界和原生模块加载 |
| [native_runtime.ts](../src/game/native_runtime.ts)、[quest_transport.ts](../src/game/quest_transport.ts) | 游戏观察、任务操作和原生流程 |
| [run_session.ts](../src/core/run_session.ts)、[shop_window.ts](../src/game/shop_window.ts) | 业务规则与真实交易资格 |
| [game-dir.js](../scripts/game-dir.js)、[deploy.js](../scripts/deploy.js) | 游戏目录探测和部署；复用时注意现有 argv 接口 |
| [native/README.md](../native/README.md) | 原生构建、测试及依赖说明 |

## 4. 架构与实现约束

CLI 建议使用 Node.js，首版使用 `.mjs` 和 Node 内置模块，沿用项目工具链，无需再启动 Node 常驻代理服务。建议布局为 `cli/mhr.mjs`、`cli/lib/`、`cli/scenarios/`；可增加 npm 快捷入口，但给出可直接执行的 Node 命令。

新增游戏能力继续放在 TS→Lua 业务侧，由同一个游戏更新回调调度。HTTP 线程只处理普通数据和队列，不能调用游戏 SDK、访问托管对象或随意进入 Lua state。

先保留现有 HTTP 接口。新观察数据可发布到 `/api/state` 的分区，如 `runtime`、`ui`、`operations`；不要为了每个观察项重复采样游戏对象。新字段应保持旧 Vue 兼容，必要时升级协议并明确兼容范围。

建议将命令 switch 逐步整理为注册表，供模块注册处理器、参数说明、只读/写入属性和允许条件。可在状态中发布命令目录，让 CLI 的 `capabilities` 展示 implemented、allowed 和 reason。首版不必生成动态网页表单，不必增加新的原生 HTTP 端点。

不能让多个独立 autorun 脚本竞争调用 `take_commands`，否则可能取走不属于自己的命令。由一个调度器消费并分派；新增模块通过注册接入。

保留现有网页、商店、补满、猫车恢复、配置编辑和会话校验。若其他 Agent 同时修改相关文件，先协调边界，避免覆盖已有功能。

## 5. 第一阶段：基于现有业务实现 CLI

以下是拟实现的命令形式，可在保持语义清晰的前提下调整：

```powershell
node cli/mhr.mjs doctor --json
node cli/mhr.mjs state --json
node cli/mhr.mjs capabilities --json
node cli/mhr.mjs probe --json
node cli/mhr.mjs run start --armor <从状态读取的选项>
node cli/mhr.mjs run choose --index <从状态读取的编号>
node cli/mhr.mjs run route inPlace
node cli/mhr.mjs run retry
node cli/mhr.mjs run stop
node cli/mhr.mjs test invincible on
node cli/mhr.mjs test kill-all
node cli/mhr.mjs shop list --json
node cli/mhr.mjs shop buy --item <商品ID>
node cli/mhr.mjs config get --json
node cli/mhr.mjs config validate --file <文件>
node cli/mhr.mjs config submit --file <文件> --version <读取到的版本>
node cli/mhr.mjs wait --stage Selecting --timeout 120
```

`config validate` 尽量复用现有校验；本地通过仍需 Lua 提交校验。配置提交必须有显式版本，不能暗中读取新版本后覆盖他人的修改。

所有联网命令统一支持 `--base-url`、`--json`、`--timeout`。默认 URL 为 `http://127.0.0.1:11777`，允许用环境变量配置。stdout 输出业务结果或一个完整 JSON 文档，进度与诊断走 stderr；帮助、参数错误、连接失败都不能输出假成功。

建议退出码：0 成功；2 参数错误；3 服务或能力未就绪/不支持；4 前置条件或命令被拒绝；5 超时；6 结果不确定；1 其他内部错误。将这些值固定在 CLI 文档和测试中。

### 提交与完成协议

1. 提交前读取新鲜状态，取得 `bridgeId`、`questUnique`、`preparation.waveToken`、`configVersion`。明确保留 null，不拿 0 代替。
2. 为每次意图生成唯一请求 ID。命令沿用现有字段发送，记录本次提交所用会话与任务身份。
3. HTTP 的 `queued: true` 仅表示接收。继续从 `/api/results` 找同一个 ID，并验证回执所属 bridgeId。
4. `queued` 不是最终成功，尤其 `killAll` 目前只表示等待执行。应根据命令等待最终回执和/或明确的游戏状态后置条件；必要时补齐业务侧完成回执。
5. 购物需等交易结论和库存/PT 读回。拒绝和 uncertain 分开；后者可能已发生实际发货，不能自动重试。
6. HTTP 提交后连接中断，不能据此认为没执行；优先查原 ID。Lua Reset、进程重启或结果历史被淘汰时，没有证据就报告 uncertain，不能编造 rejected，也不能换 ID 重发。
7. 现有回执历史只有 30 条，不是持久幂等账本。现有去重也不能证明同 ID 不同内容会被拒绝。若实现有限 TTL 的请求摘要/结果表，应测试冲突拒绝、淘汰边界和内存上限，不宣称跨重启 exactly-once。
8. CLI 单次调用及场景执行器串行发送修改命令。服务端也应正确处理网页与 CLI 并发，不能只依赖网页 busy。

`doctor` 分开报告：游戏进程、HTTP、DLL 身份、Lua 探针、业务心跳、协议兼容性。使用本机单调时钟观察 `bridgeId + counter` 是否推进，不仅检查 HTTP 可达；游戏暂停/失焦时心跳停滞应如实报告原因或 unknown，不能误判进程已退出。

## 6. 第二阶段：原生界面观察与启动流程

先调查当前安装版 SDK/RTTI 和真实运行对象，再实现接口。每个判断记录类型、方法/字段签名、使用条件和实机证据。不要仅凭方法名称就调用，不要把“对象存在”当作“窗口当前可操作”。

建议 `ui` 观察分区包含：

```json
{
  "scene": "unknown",
  "sceneToken": "当前场景实例标识",
  "loading": false,
  "busy": false,
  "dialogs": [],
  "allowedActions": [],
  "evidence": []
}
```

需要区分启动/标题、存档选择、加载、村庄、任务营地、任务战斗、结算、未知。场景、地图和弹窗是不同维度：斗技场起点属于任务内，不能当村庄；网络弹窗可以覆盖任意场景。未知信息用 null/unknown，不能伪造默认值。

弹窗至少包含稳定类型、实例 token、消息 ID 或可得文本、可操作按钮 ID、启用状态。对网络失败/离线选择、DLC 通知、确认返回、结算等分别调查。未知或未分类弹窗应停下并报告，禁止通用“确认所有弹窗”。

拟新增 CLI：

```powershell
node cli/mhr.mjs game launch
node cli/mhr.mjs ui inspect --json
node cli/mhr.mjs wait --scene title --timeout 120
node cli/mhr.mjs saves list --json
node cli/mhr.mjs saves load --slot <明确指定的槽>
node cli/mhr.mjs dialog respond --token <当前token> --button <按钮ID>
node cli/mhr.mjs wait --scene village --timeout 120
node cli/mhr.mjs game exit
```

进程启动、目录探测和退出后的进程确认属于本机 CLI；加载存档和窗口操作属于 Lua 游戏侧。远端 `--base-url` 下不能把本机进程当远端游戏，应明确不支持远端进程管理。

启动可复用 Steam App ID 1446780 与既有游戏目录探测。启动前检查是否已有进程，避免重复启动。不能在 doctor/state 中自动启动游戏。退出优先原生正常退出；强制终止必须是单独的显式选项，不可作为失败后的默认补救。

存档操作只允许观察和加载明确槽位，不提供创建、删除、覆盖存档。场景/弹窗写命令携带当前 token，执行时重新核对，拒绝陈旧操作。原生接口暂不可得就报告 unsupported；键鼠辅助若确有必要，作为显式可选适配器列出限制。

## 7. 第三阶段：补齐验证所需控制与观察

优先补充以下能力，继续走现有命令入口：

| 能力 | 完成证据 |
| --- | --- |
| `enemy.kill` 指定 UID | 只命中目标 UID，观察原生死亡/捕获与业务清波；不能只报告已施加伤害 |
| `player.moveToCamp` | 在明确支持的单人测试任务内操作，读回实际位置与集结判定 |
| 任务接取/出发/返回、结算确认 | 原生任务阶段、实例和界面确实变化；复用 transport，不复制接取逻辑 |
| 波次观察 | 计划与实际 UID、怪种、加载阶段、同时存活数、清波阻塞原因 |
| 数值观察 | 原生基础 HP、最终 HP、计划倍率与实际结果，未知项明确标注 |
| 异步操作观察 | queued/running/最终结果、阶段、请求 ID、相关会话和状态证据 |
| 有界事件记录 | 单调序号、游标、历史缺口标识；可关联任务/波次/请求 |

已有 `killAll` 继续保留并明确影响范围。不要把它作为定向击杀的实现。无敌等测试能力应保持现有单人/任务限制。

脚本重载可以作为后续能力调查，但不能在任意 SDK 回调栈中销毁当前 Lua state。若无法证明安全重载，继续保留人工 Reset，并让 CLI 明确等待新 bridgeId；第一阶段无需实现远程 Reset。

## 8. 场景执行器与验收

实现 `scenario run <json文件> --report <输出文件>`。场景使用有限、声明式的 action/wait/assert 步骤，不能支持任意 JavaScript/Lua eval。等待用条件和 deadline；仅轮询间隔使用短 sleep，不能用“等 30 秒就认为怪已出现”。

先支持阶段、层数、任务实例、指定 UID 出现/死亡、指定怪种存活数、购物可用、请求结果等明确条件。等待中检查 bridgeId 变化，默认中止涉及旧任务的操作。失败报告保留最后状态、请求 ID、预期条件和未满足原因。

至少交付以下真实验证场景：

1. 服务未启动、DLL 启动但 Lua 未发布、业务就绪三种情况能区分。
2. 从已进村开始：开局→选择 Single→真实生成→测试击杀→原生清波→PT 只结算一次→集结→下一层。
3. Sequential：第一只死亡后第二只生成；第一只死亡不提前结算整波奖励。
4. Simultaneous：保留第一只活着，读到两只独立 UID 同时存活；不能用先后出现累计数冒充同时在场。
5. 波次间购买：资格、PT、库存前后值一致；战斗中拒绝购买。
6. Reset 后旧会话写命令被拒绝、旧快照不再当新状态、未确认交易不自动重发。真实 Reset 可先由用户执行，单独记录人工步骤。
7. 进阶阶段：从标题加载指定存档进村，并正确处理至少一种真实出现的网络弹窗；未知弹窗可靠停止。

分开报告单元测试、standalone DLL 测试、Lua harness 和真实游戏结果。未实机验证不能写“完成”。游戏未运行时仍可开发和测试 CLI，但报告中保留待验收项。

## 9. 性能、安全与仓库要求

- 状态采样复用已有频率，CLI 默认约 500 ms 轮询并可配置合理下限。没有客户端时不新增高频磁盘遥测；事件内存有界，只在报告导出时写文件。
- 记录采样、序列化、命令执行等耗时，保持诊断有界且限频。不能恢复过去每秒重写多 MB JSON 的探针。
- 不提供远程任意 Lua 执行、任意 SDK 调用、任意内存读写。只开放有参数校验和前置条件的命令。
- 当前监听 0.0.0.0 且无登录鉴权；来源检查不是客户端身份认证。若加入 token 认证，网页与 CLI 一并兼容，token 不进 Git/报告/日志。不要为赶工放宽现有 Origin 校验。
- 不自动关闭用户正在玩的游戏、不在活跃局中重载脚本。DLL 替换须等游戏退出，脚本更新须考虑重载造成局内状态丢失。部署与启动/退出分别是显式动作。
- 仅提交源码、说明和必要的小型脱敏证据；禁止提交 DLL/OBJ/EXE/MAP、构建目录、前端 dist、生成 Lua/SDK 和日常日志。不要自行改 Git 历史，不覆盖工作区其他未提交修改。

## 10. 建议交付顺序

1. **第一批**：CLI 传输、doctor/state/probe、现有命令、回执与 wait；补必要测试和使用文档。先给出能直接跑的命令。
2. **第二批**：只读 UI/场景识别，标题/存档/弹窗接口调查表；实现已证实的加载流程。
3. **第三批**：指定 UID 操作、回营、原生任务动作、操作与事件观察，跑业务场景。
4. **第四批**：长局、并发、断线、Reset、购物 uncertain 等恢复验证。

每批汇报：改动、实跑命令、验证结果、未支持能力、下一批阻塞证据。遇到未知原生接口先收集论据并做最小实验，不连续猜字段、拨状态，也不要堆一批未实现的 HTTP 端点。

## 11. 参考资料

先读本仓库源代码及上述实机证据。涉及 REFramework 接口时使用安装版对应资料，不能把上游最新版本的能力直接套到当前版本：

- [固定版本 REFramework API.h](https://github.com/praydog/REFramework/blob/5bae4701396248a776c1de19f5be9552022295d5/include/reframework/API.h)：生命周期与插件 ABI。
- [同版本 ScriptRunner.cpp](https://github.com/praydog/REFramework/blob/5bae4701396248a776c1de19f5be9552022295d5/src/mods/ScriptRunner.cpp)：Lua 加载、重置、回调上下文，调查时按实际代码确认。
- [REFramework Lua API 文档](https://cursey.github.io/reframework-book/api/sdk.html)：SDK 访问方式；与固定版本源码交叉核对。
- [仓库上游评估](review-reframework-upstream.md)：已调查的安装版与上游差异。
- [ReaPy 激活脚本](https://github.com/RomeoDespres/reapy/blob/master/reapy/reascripts/activate_reapy_server.py)、[服务端实现](https://github.com/RomeoDespres/reapy/blob/master/reapy/tools/network/server.py)：仅参考外部请求与宿主执行循环的分工，不移植其阻塞或任意对象调用协议。

新增具体 UI/存档能力时，在交付说明里追加确切源码版本、类型签名和实机证据路径，不能只列搜索结果或无关模组链接。
