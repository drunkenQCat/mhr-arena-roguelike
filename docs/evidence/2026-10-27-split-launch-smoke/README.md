# 拆分版产物启动冒烟 — 2026-10-27 — PASS（附已知缺口）

拆分后的 webconsole.dll（408KB，src/common.h + http_server + plugin_main）与
310KB bundle（含 Runtime.DebugMode 门 + tp/killAll/setInvincible 命令集）实机加载验证：

- /api/health 200（启动 ~20 秒内）；/api/state 含 protocol/bridgeId/configVersion/真实 PT 150
- setInvincible(true)：applied，"Invincible ON (solo custom arena only)"
- tp：rejected "未知命令：tp" —— 另一并行会话重构了命令分发且未注册 tp，
  属已知命令集缺口（fork 前版本的 tp 实现未合并），非拆分回归；待补合并。
- 会话安全实测：错误 bridgeId 的命令被正确拒绝（"连接会话已更换"）

证据文件：webconsole_state.json（counter/invincible 状态）、webconsole_results.json
（命令结果）。事件时间戳 23:5x 前后。
