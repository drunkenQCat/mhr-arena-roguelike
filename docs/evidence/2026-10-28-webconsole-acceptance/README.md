# Web 控制台实机验收 — 2026-10-28 — PASS

拆分版产物（webconsole.dll 408KB src 三文件 + bundle 310KB 含 debug 门/tp 命令集）
在真实游戏内验证：

- 插件加载：health 200（启动 ~20 秒内）
- /api/state：protocol 3、bridgeId、configVersion、真实 PT/层数/猫车
- setInvincible(true)：applied，"Invincible ON (solo custom arena only)"
- /console：Vue 页面 200（127KB，含商店面板分类页签+商品表+购买资格/拒绝原因）
- 会话安全：错误 bridgeId 拒绝（"连接会话已更换"）——防过期页面误操作
- 结果持久化：webconsole_results.json 落盘（POST 后 2 秒内可读）

## 验证方式

curl 代位浏览器走同一 API 路径（§9 链路的 API 侧）；真实浏览器渲染与交互
（Vue 页面在浏览器打开并操作）由玩家执行——玩家确认页面可显示后本验收闭环。
商店面板数据（50 商品分类+资格）由桥 2Hz 发布至 state 文件。

## 未覆盖（后续迭代）

- 浏览器端实际点击交互（curl 代位已验证同一 API）
- 补满/服务类购买（等效果接线）
- 性能分位数（5Hz 长跑帧时间对比）
