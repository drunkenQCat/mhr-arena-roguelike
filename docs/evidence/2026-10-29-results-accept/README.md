# 结算页推进证据

对应 [研究结论与操作说明](../../research-result-screen.md)，可执行脚本为 [result_accept.lua](../../../reframework/autorun-probe/result_accept.lua)。

环境：Rise 16.0.2.0，HTTP 插件 0.3.5，PID 41084，session `41084-6575803952`；REFramework 为另一个 Agent 部署、支持 HTTP Reset/Run Script 的 fork。屏幕版本标记 `v1.5.9.1+4-2e7ce5b9`，不能与上游原版二进制混同。

| 文件 | 含义 |
|---|---|
| `reward-final-pass.json` | 当前仓库脚本实机完整通过：8 次输入脉冲、738 帧、after=village、道具箱总增量 6 件 |
| `reward-first-report.json` | 初版脚本已走完奖励、动画、保存、End，但在任务 identity 清除、村庄尚未 ready 时误报 FAIL；随后 CLI 和画面确认已回村 |
| `reward-second-teardown-error.json` | 第二版同样正常推进，但在结果对象卸载时继续读取旧 FSM，验收报 ERROR；保留该失败证据，当前版已调整观察顺序 |
| `metadata.json` | 同一游戏进程的输入、结果 FSM、相关 Action 的完整签名／字段偏移和方法地址 |
| 两份 `*.update.txt` | 只读捕获原生机器码的线性反汇编，截断至入口后的首个 int3 填充前，重点查看研究文档指明的调用点 |
| `manifest.json` | 捕获环境说明与本目录数据文件 SHA-256 |

原生代码捕获只使用 `OpenProcess(QUERY_INFORMATION | VM_READ)` / `ReadProcessMemory`，未写进程内存。所有地址只适用于对应版本和进程，不作为后续调用常量。

除以上有物品的成功结果外，还验证过停止测试任务后的空报酬 `Payoffselect`：在对应 Action.update 内一次决定键脉冲即进入 Save，随后 CLI 与画面均确认回村。该次没有保存独立的机器可读最终报告，因此与完整 PASS 文件区分陈述。

本轮 Computer Use 仅用于窗口识别／恢复和查看画面，无按键或鼠标游戏输入。最终通过 CLI `game reset` 在村庄清掉临时 hook，未改正式 TS、CLI 或常驻 Lua bundle。另一个 Agent 的 `research-shop-unavailable-and-equipment-wiring.md` 未触碰。
