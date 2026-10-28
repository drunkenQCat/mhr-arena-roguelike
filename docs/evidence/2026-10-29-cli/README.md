# CLI 第一批实机记录（2026-10-28，CLI 交付同日）

游戏进程 PID 30880，运行 DLL **0.3.3** + 当时部署的 bundle（协议 3）。
本次是在**旧版运行实例**上执行 CLI，因此 CLI 期望的协议 4 与实况不符——这不是 CLI 缺陷，
而是本轮同时把 Dart/页面/Lua 升到协议 4 后，DLL 必须重启游戏才能替换（部署时 EBUSY）。

## 实跑命令与结果

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `node cli/mhr.mjs state` | 0 | 读到阶段、层数、PT、任务/波次、bridgeId |
| `node cli/mhr.mjs doctor --json` | 3 | HTTP/DLL/Lua 探针/业务心跳全部 up/live/pass；**协议 DLL 3、Lua 3 ≠ 期望 4** 明确列为阻塞，不谎报就绪 |
| `node cli/mhr.mjs probe` | 0 | DLL 0.3.3，sessions=8、pings=16、commands=13；Lua 探针 PASS（`30880-403530972:lua-8`） |
| `node cli/mhr.mjs capabilities` | 0 | 逐条 implemented/allowed/reason |
| `node cli/mhr.mjs shop list --category 基础补给` | 0 | 分类、价格、实际持有/上限、资格原因 |
| `node cli/mhr.mjs run route inPlace` | 0 | 提交→回执 `applied` |
| `node cli/mhr.mjs run start --armor 骨套（均衡）` | 0 | `applied`，阶段 Selecting |
| `node cli/mhr.mjs run choose --index 0` | 0 | `applied`；`wait --stage AwaitQuest` 551ms 满足，随后 Combat |
| `node cli/mhr.mjs test kill-all` | **6** | killAll 回执恒为 `queued`（执行在后一帧），15s 内无终态 → 按协议报**不确定**，不谎报成功；随后状态确实进 Carve、PT 180→262 |
| `node cli/mhr.mjs wait --shop --timeout 120` | 0 | 43ms 内可购买 |
| `node cli/mhr.mjs shop buy --item ammo_n1` | **4** | 回执 `rejected`：`canAddItem=false and slot not full`；PT 与限购已回滚。CLI 未重试 |
| `node cli/mhr.mjs run stop` + `wait --stage Finished` | 0 | 已停止，回村前 `capabilities.start=false`（原生任务实例仍在），如实显示 |

`kill-all` 的退出码 6 是**预期行为**：任务书要求不得用"命令已入队"或"回执 applied"冒充击杀成功。
要拿到确定结果需要后续批次的 `enemy.kill(uid)` 或原生死亡事件回执。

`shop buy` 的 4 是**业务拒绝**（背包无法容纳该弹药），不是 CLI 传输错误；`shop list` 的 `canBuy`
来自配置与持有量，未覆盖 `canAddItem`（原生背包槽），两者不一致已在报告中暴露。

## 契约测试（不依赖游戏）

`node cli/tests/contract.mjs` — 33 项全部通过：缺失服务(3)、Lua 未发布(3)、就绪(0)、
403/429(4)、断线(6)、回执超时(5)、rejected(4)、uncertain(6)、会话变化(6)、
不可购买本地拒绝且不发送、`config submit` 缺版本(2)/版本过期(4)、配置校验(2/0)、
wait 满足(0)/超时(5)、协议不符(3)、场景通过(0)/失败(4)。

## 协议 4 复测（DLL 0.3.4，进程 PID 5072）

旧实例 30880 用 `taskkill /PID 30880` 正常结束（无参为优雅关闭，未用 `/F`），
`npm run deploy` 成功写入 806400 字节，部署后 DLL SHA-256 与构建产物一致
（`96f9c434294f37c7…`），直接启动游戏 EXE 后插件在约 11 秒内响应。

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `node cli/mhr.mjs doctor --json` | **0** | 四层全 PASS：HTTP up、DLL 0.3.4、Lua 探针 module=0.3.4、业务 live，心跳 20→22，协议 DLL 4 / Lua 4 / 期望 4 |
| `node cli/mhr.mjs probe --json` | 0 | sessions=1、pings=2、protocol=4 |
| `node cli/mhr.mjs scenario run cli/scenarios/readiness.json` | **0** | 三步全过（状态可读 / protocol=4 / 有会话标识） |
| `node cli/mhr.mjs ui` | 0 | 新 `state.ui` 分区已上线：`scene=unknown`、`loading=true`、`PlayerList=0`、`IsCanInvokeQuestBoard=false`——即标题/加载阶段，如实标 unknown，未伪造 village |

证据文件：`doctor-live-v034.json`、`probe-live-v034.json`、`ui-title-v034.json`、
`scenario-readiness-v034.json`。

标题界面下 `scene=unknown` 是**正确结果**：视角传感器只覆盖"任务内/村内"判据，
不区分标题与存档选择（第二阶段待做）。

## 未实机验证

- 进村后（PlayerList>0）的 `run.start` 与 `wave-cycle` 场景本轮未跑：重启后的新实例
  停在标题/加载画面，没有存档已被载入。
- 标题/存档/弹窗（第二阶段）、`enemy.kill(uid)`、回营传送（第三阶段）未实现。