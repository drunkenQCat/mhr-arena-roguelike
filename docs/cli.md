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

## ui 观察的边界

`state.ui` 由 Lua 侧 `WebConsoleBridge.uiSection()` 发布：`scene`（quest / quest_ready /
village / unknown）、`mapNo`、`loading`、`busy`、`questStatus`、`allowedActions` 与逐项
`evidence`（`QuestManager.isActiveQuest`、`StageManager.get_MapNo`、
`GuiManager.IsCanInvokeQuestBoard`、`PlayerManager.PlayerList`）。

它是"视角传感器"，不是窗口分类器：标题、存档选择、原生弹窗都看不到，
因此 `dialogsKnown=false`、`dialogs=[]`，`scene=unknown` 时不推断。
旧版 bundle 没有该分区时，CLI 明确报告"未发布 ui 分区"而不是给默认值。

## 当前未支持

- 进程启动/退出、存档槽、原生弹窗观察（任务书第二/三阶段）。
- 远端 `--base-url` 下不支持本机进程管理。
- `killAll` 没有专门的完成回执，需要补 `enemy.kill(uid)` 或事件后再声称精确击杀。