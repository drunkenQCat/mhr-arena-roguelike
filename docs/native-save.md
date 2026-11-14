# 原生角色保存

在实验 worktree 的 CLI 中执行：

```powershell
node cli/mhr.mjs game save --base-url "$env:MHR_IN1" --json
```

这不是直接调用序列化器。入口为游戏原生
`snow.SaveServiceUtility.SaveLoadAgent.requestSaveAll(System.Boolean)`，参数 `false`。
普通保存菜单的 `GuiSaveDataSelectMenu.routineSave` 与 `routineOverwriteSave`
也构造指向 Agent 的托管完成委托，并以相同标志调用 SnowSaveService。
Agent 的请求状态为 1，完成回调 `onRequestEnd(Boolean)` 将状态设为 2（失败）或 3（成功），
`takeResult()` 消费结果。不能以 `SnowSaveService.requestSaveAll(false, nil)` 替代：后者跳过了完成委托。

请求只在角色已加载、无活动任务、村庄菜单可用、底层保存空闲时接受。
模组仍在准备或战斗中，或者原装备／背包恢复尚未核验时拒绝。
执行排到 `SnowSaveService.doUpdate` 的 post，重新核对角色归属和现场；
不从 HTTP 线程或任意 Lua 帧直接创建保存委托。

`queued` 仅为排队。`applied` 同时要求本次新保存的 busy→success、
匹配角色槽、无底层失败，以及 Agent 成功回调。旧成功值或系统保存不能冒充角色保存。
排队超时但未执行时为 rejected；原生请求发出后无法确认则为 uncertain，不自动重发。
原装备恢复记录继续由原有 RecoverySave 校验后退役，不直接清除恢复文件。

Instance1 2026-11-13 实验：当前原生角色槽 1，底层存储槽 2，
Agent 0→1→3、takeResult=true、LastSaveResult=2、LastSaveFailed=false；
装备和物资恢复记录退役，开局重新可用。
该进程 Steam 模块来自 Instance1/_storage_，实际保存位置为
APPDATA/Goldberg SteamEmu Saves/1446780/remote/win64_save，
当前角色文件为 data002Slot.bin。Instance1 根目录 local_save.txt 不能证明
被 _storage_ 内的模块采用。部署和测试必须按实际加载模块核对存档目录。

此证据不代表战斗中保存、切换角色时保存或任意平台保存都可用。
