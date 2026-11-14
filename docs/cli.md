# Agent 游戏控制 CLI

面向 Agent 的终端入口，把现有的 HTTP/内存桥业务能力变成可直接执行的命令。
实现约束与验收标准见 [任务书](task-agent-game-cli.md)。

```powershell
node cli/mhr.mjs doctor --json          # 分层健康：HTTP / DLL / Lua 探针 / 业务心跳 / 协议
node cli/mhr.mjs state                  # 业务快照（阶段、层数、PT、任务、波次）
node cli/mhr.mjs probe                  # DLL 身份 + Lua 探针报告
node cli/mhr.mjs ui                     # 视角/场景观察（未识别即 unknown，附证据）
node cli/mhr.mjs capabilities           # 每条命令 implemented / allowed / 阻塞原因
node cli/mhr.mjs shop list              # 目录、价格、实际持有、购买资格
node cli/mhr.mjs run start --armor "骨套（均衡）"
node cli/mhr.mjs run choose --index 0
node cli/mhr.mjs run route inPlace
node cli/mhr.mjs test kill-all
node cli/mhr.mjs wait --stage Selecting --timeout 120
node cli/mhr.mjs scenario run cli/scenarios/wave-cycle.json --report out.json
```

## 通用约定

| 选项 | 说明 |
| --- | --- |
| `--base-url URL` | 默认 `http://127.0.0.1:11777`，也可用 `MHR_CLI_BASE_URL` |
| `--json` | stdout 只输出一个 JSON 文档（失败时为 `{ok:false, exitCode, error}`） |
| `--timeout S` | 单次 HTTP 超时，默认 3 秒 |
| `--receipt-timeout S` | 等待终态回执的时间，默认 15 秒 |

stdout 只放业务结果，进度与诊断在 stderr。连接失败、参数错误、超时都不会输出假成功。

## 退出码

| 码 | 含义 |
| --- | --- |
| 0 | 成功（回执 `applied` 且状态后置条件成立） |
| 1 | 内部错误 |
| 2 | 参数错误、文件不可读、本地配置校验失败 |
| 3 | 服务或能力未就绪/未支持（DLL 无响应、Lua 未发布、协议不符） |
| 4 | 前置条件不满足或命令被拒绝 |
| 5 | 超时（等待回执或等待状态超时） |
| 6 | 结果不确定（连接中断、会话变化、回执仍为 queued/uncertain）——**不要自动重发** |

## 提交与完成协议

1. 每次写命令先读 `/api/state` 取新鲜身份：`bridgeId`、`questUnique`、
   `preparation.waveToken`、`configVersion`（`null` 保持 `null`，不用 0 顶替）。
2. 生成唯一请求 ID，随命令一起发送；Lua 侧按 ID 去重。
3. `POST /api/command` 返回 `queued: true` 只代表入队。CLI 继续轮询
   `/api/results`，只认 `applied` / `rejected` / `uncertain` 终态，并核对回执的 `bridgeId`。
4. 连接在提交后中断：结果记为不确定（退出码 6），CLI **不会**换 ID 重发。
5. 购物额外等交易回执（`queued` 不算终态）并读回持有量/PT。
6. `test kill-all` 的回执是 `queued`，完成证据是怪物全部死亡/捕获，否则退出码 5。

## 场景执行器

`scenario run` 只接受声明式步骤，不支持任意 JS/Lua：

```json
{
  "name": "wave-cycle",
  "timeoutSeconds": 240,
  "steps": [
    { "name": "开局", "kind": "action", "cmd": "startRun",
      "expect": "sessionStage=Selecting", "timeoutSeconds": 20 },
    { "name": "原生出怪", "kind": "wait", "expect": "enemies.0.dead=false", "timeoutSeconds": 90 },
    { "name": "仍有下一层", "kind": "assert", "expect": "layer>=1" }
  ]
}
```

条件语法为 `path 运算符 值`（`=`、`==`、`!=`、`>=`、`<=`、`>`、`<`），
或只写 `path` / `path!=` 表示"存在且非空"。等待使用条件 + deadline，
轮询间隔只影响检查频率，不用固定 sleep 推断结果。等待期间 `bridgeId` 变化即中止：
旧会话的条件不再成立。`--report` 输出完整步骤报告（含失败步骤的最后观测）。

## 测试

```powershell
node cli/tests/contract.mjs     # 本地假插件：退出码、拒绝、断线、超时、会话变化、场景
npm run test:cli
```

契约测试不依赖游戏进程；真实游戏结果需另跑并通过报告区分。

## 原生菜单与自动进村

```powershell
node cli/mhr.mjs game launch --json
node cli/mhr.mjs game enter --slot 1 --timeout 120 --json
node cli/mhr.mjs game return --timeout 120 --json
node cli/mhr.mjs ui --json
node cli/mhr.mjs saves list --json
node cli/mhr.mjs title advance --json
node cli/mhr.mjs title continue --json
node cli/mhr.mjs saves load --slot 1 --json
node cli/mhr.mjs dialog close --token <从ui读取的token> --json
node cli/mhr.mjs wait --scene village --timeout 120
```

`game launch` 只请求本机 Steam 启动 Rise，已运行时不重复启动；启动请求成功不等于已加载角色。远端 URL 不支持本机进程管理。

## 脚本控制（需 fork 版 REFramework dinput8）

```powershell
node cli/mhr.mjs game reset --json
node cli/mhr.mjs game save --base-url "$env:MHR_IN1" --json
node cli/mhr.mjs game run-script cli/tests/probe-sample.lua --timeout 20 --json
node cli/mhr.mjs game last-error --json
```

`game reset` 触发与 ScriptRunner "Reset scripts" 相同的重置路径（下一帧生效，Lua epoch +1，旧 bridgeId 的请求被拒绝）。`game run-script` 优先把本地文件按内容上传（写入 `reframework/data/webconsole_runs/` 后执行），本地读不到则把参数当作游戏目录内的相对路径。两种形式都要求 ASCII 路径/名称，且不允许 `..` 与分隔符逃逸。提交后 CLI 轮询 `/api/probe/report`，直到出现 `script` 与提交时 `epoch` 都匹配的报告；超时则读取 `GET /api/script/error` 的框架错误文本一并输出。

探针契约：脚本整体 `pcall`，把 `script`、`epoch`、`session`、`verdict`（PASS/FAIL/ERROR）、`steps`、`metrics`、`error` 组成报告，经 `require("webconsole").publish_probe(json.dump_string(report))` 发布。通道选择上 `publish_probe` 是探针专用槽，不要使用 `publish_results`（业务交易回执专用，会被覆盖）。

`game enter` 必须指定已有槽位（1..3），会等待 DLL/Lua 初次就绪，观察菜单并依次处理已支持的启动连接错误、自动保存提示、标题和存档选择、被动加载提示及进村连接错误。最后必须观察到村庄就绪、玩家存在、没有已观察到的阻塞弹窗，才返回成功。首次获取会话后若 Lua Reset/连接失败则停止，不重放写操作。完整流程默认超时 120 秒。

菜单稳定且心跳更新后才提交；每次写操作携带 sceneToken，弹窗操作额外携带 dialogToken。Lua 会再次核对。一次进入流程最多发起一次存档加载，防止加载时旧 UI 对象尚未销毁而重复操作。`saves load` 的回执证明原生加载流程已开始，不证明已经进村；完整完成判据由 `game enter` 检查。

`state.ui.scene` 可包含 autosave_notice / title_press / title / save_select / save_menu_unknown / loading / village / quest / quest_ready / quest_reward / quest_payoff / quest_result_wait / unknown。`loading` 在没有依据时为 null；玩家对象缺失不直接视为加载，玩家对象存在也不能直接视为进村（存档预览已有玩家）。空槽会带默认名字，occupied 还检查原生猎人等级。

当前菜单适配器固定于安装版 REFramework/游戏 RTTI，加载入口只接受实机观察过的原生 LoadDataSelect 节点。新游戏/保存/覆盖共用界面不会获得加载权限。网络错误自动关闭目前仅支持实测的 MR-111-83、BUTTON_CURSOR_ON 类型；未知错误/有按钮的未知提示会停止并报告。无按钮的连接/加载信息只等待，不发确认。

`dialogsKnown=false` 表示覆盖范围有限；dialogCoverage 列出网络错误、通用确认和信息窗口，并不代表已经识别全部原生窗口。地图编号仍无已验证访问器，不伪造 mapNo。原生观察分区不存在时，CLI 保持 unknown。

## 验证与当前边界

效果订单参见 [策划商品效果实验](designer-effects.md)。`effects continue` 仅在受保护的 `PreparingCombat` 阶段、已处理失败订单后请求重新核验；命令成功不等于已经开放战斗，须继续检查 `nativePreparation` 和 sessionStage。未交付可以放弃，未知交付不能通过此入口重放或退款。

- 原生适配器与桥回归：`npm test -- --run src/game/native_ui.test.ts src/game/webconsole_bridge.test.ts`。
- CLI 传输合同：`npm run test:cli`；自动进村合同：`node --test cli/tests/game-entry.mjs`。
- 实机结果与已知限制以最新 evidence 记录为准。单元测试、假 HTTP 服务和真实游戏验证分开报告。
- 尚未实现通用游戏退出/返回标题、所有类型弹窗应答、远程 Reset、指定 UID 击杀与自动回营。
- `killAll` 仍需用实际死亡/清波后置条件验收；不能把入队视为讨伐完成。


## 结束本局与原生结算

`run stop` 结束模组会话并允许原生任务结束；回执 applied 不代表已回到村庄。Ended owned run 会自动启动有界的结算推进，网页和 `state.ui.returnFlow` 显示 waiting / complete / stopped。仅处理本模组任务的原生 Reward 领取与 Payoffselect 确认；BeforeSave / Save 等待游戏自行完成。不强跳 FSM、不强制保存，也不自动确认未知弹窗。自动步骤不占用业务命令回执，防止 CLI 把后台结算动作误当成 stop 的结果。

`game return --timeout 120` 用于已经 Finished / Fault 的本模组任务，提交一次返回请求后等待实际村庄就绪且存在玩家；本来就在村庄时不提交操作。活动战斗中不能用它代替 stop，未知弹窗或未确认的输入会停止，不能盲目重发。结算期间 PlayerList 为空是正常现象，不应据此调用玩家生成或回村接口。

2026-11-05 本机双引擎已完成 stop 后两端自动回村；R12/R13记录覆盖共享猫车与回村，但未核实原生结束类型，不能算失败完整验收。11月8日及9日独立实测已记录双端 Failed=4 后保存回村；正常完成 Success=3 与三猫失败分开验收。详见 [多人运行说明](multiplayer-runtime.md)。


存档选择的 slot 对应 SnowSaveService 原生角色槽（CLI 从1计数），名称来自同一原生数组，不能用可能重排的界面预览列表作索引。开局/停止等命令回执返回前会先发布新业务状态；原生异步效果仍按 queued/后置条件判定。恢复待办时应读 control.startup 与 message，不能靠 Reset scripts 绕过错角色或损坏记录保护。
