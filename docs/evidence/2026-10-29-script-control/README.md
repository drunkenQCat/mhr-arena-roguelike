# 脚本控制端点实机验证（fork 框架 + DLL 0.3.5，2026-10-29）

环境：Steam Rise 进程 pid 80564，dinput8.dll = drunkenQCat/REFramework `plugin-script-reset` @ `2e7ce5b`（基线 praydog `5bae4701`，CI 13/13 target 构建通过），webconsole.dll 0.3.5 / protocol 4。原版框架备份为游戏目录内 `dinput8.dll.praydog-5bae470.bak`。

| 验证项 | 结果 |
| --- | --- |
| fork dinput8 加载 + 插件 API 挂载 | ✅ doctor 四层全绿，DLL/Lua 协议 4 |
| `game reset`（POST /api/script/reset） | ✅ queued epoch=1；3s 后 `/api/probe` sessions=2、pings 2→4——重置生效且 autorun 验收探针自动重跑 |
| `game run-script`（content 形式） | ✅ probe_script_api.lua 上传落盘 `webconsole_runs/`，游戏线程执行，报告经 publish_probe 回读：script/epoch(=2) 匹配，verdict PASS，steps 全过 |
| `game run-script`（语法错误负路径） | ✅ CLI 退出码 5，并经 `GET /api/script/error`（fork `last_script_error`）带出框架原文：`sol: syntax error ... near 'is'` |
| `game last-error` | ✅ 正常态 hasError=false；错误态返回框架原文 |

结论：脚本控制反馈闭环成立——改探针 → `game run-script` → PASS/错误文本直接回到 CLI 终端，全程无需进游戏菜单或手输 Lua。
