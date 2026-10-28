# MHR Arena Roguelike — M2

Monster Hunter Rise 16.0.2.0 / REFramework v1.5.9.1 的斗技场肉鸽研究模组。
TypeScript 经 TypeScriptToLua 编译为单文件 `reframework/autorun/mhw_rogue.lua`。

**M2a/M2b/M2c 的实现和离线验证已完成，游戏内验收由玩家执行。**
当前实现为单人模式；原生连刷、自动柜台、计时/结算拦截和倍率 hook 都仍需实机确认。
默认使用 inPlace 同场续波，失败自动回退 reentry。顺序波次已实测；同场同时双怪仍有第二只未出场的问题。

## 实现内容

- **M2a**：从原生 BOSSRUSH 603 深克隆任务 900102，独立复制全部怪槽数组；提供
  Great Izuchi → Great Baggi 的零 PT 连刷测试。任务位于村庄探索列表，旧 900101 原型保持独立。
- **M2b**：观察原生怪物列表及死亡/捕获事件；按唯一 ID 和目标数量去重，空场不会结算。
  本模组准备的任务才启用计时与成功结算拦截；HP/攻击倍率作用于难度倍率返回值，
  不把 `_VitalTbl` / `_AttackTbl` 的表索引当成数值倍率。
- **M2c**：三选一 → 写怪表 → 原生接取/出发 → 真实击杀发 PT → 剥取 → 回起始点集结
  → 同场下一层；异常时退回原生重进流程。PT、全局猫车数、解锁状态跨任务保留。
- 原生柜台超时/取消会释放输入与确认 hook；可以关闭自动接取、手动承接已准备好的任务。
- 同场热换失败会退回重进；顺序出场失败可改为原生 DEFAULT 同时出场重试，均不会凭空发 PT。

详细操作、配置、日志、失败恢复及实机验收表见 **[M2 测试说明](docs/m2-testing.md)**。

## 构建与安装

```bash
npm ci
npm run typecheck
npm test
npm run build:nocopy   # 生成 SDK、配置与 Lua；不写入游戏目录
npm run check
python -m pip install lupa
npm run check:runtime # 在真正的 Lua 5.4 中离线执行编译产物
```

关闭游戏后执行 `npm run build`，会构建并部署到自动探测的 Rise 目录。
也可将产物手动复制至游戏 `reframework/autorun/mhw_rogue.lua`。
不依赖热重载保留进行中的肉鸽状态；重启/重载脚本后从新局开始。

覆盖配置：把**完整的** `data/rogue_config.json` 复制到游戏
`reframework/data/mhw_rogue_config.json`，修改后重新加载脚本。缺字段或非法值会回退到内嵌配置。
配置不是放在游戏根目录，参见 [REFramework JSON API](https://cursey.github.io/reframework-book/api/json.html)。

## 网页控制台：前端与后端

控制台面向玩家和策划，提供运行状态、玩家位置与集结距离、波次选择、商店、测试控制和数值编辑。使用 **Vue 3 + Vite + TypeScript**，通过 `vite-plugin-singlefile` 构建为一个内联 JS/CSS 的 HTML。正式使用时不需要启动 Node 或 Vite 服务。

```text
电脑／手机浏览器：Vue 单 HTML
          │ HTTP，同源 API
          ▼
webconsole.dll：游戏进程内的 C++ HTTP 服务
          │ JSON 文件信箱
          ▼
REFramework Lua 桥：在游戏回调中校验并执行命令
          │
          ▼
RunSession／ShopWindow／原生游戏 API
```

后端分为两层：原生插件使用 `cpp-httplib` 处理网络和网页分发，Lua 桥执行游戏操作。网络线程不直接访问游戏对象；命令经文件信箱进入游戏回调，校验脚本会话、任务实例、波次或配置版本后执行，再写回结果。浏览器按请求 ID 查询最终回执，购买显示“排队”不代表发货完成，结果不明时不要重复购买。

目前使用 HTTP 轮询和文件信箱，不是 WebSocket。Lua 每 12 帧检查命令、约每秒发布一次小型状态快照；原生端共享短时读取缓存。心跳停止时，网页禁用操作，HTTP 服务存活本身不代表游戏状态仍在更新。

### 构建、部署与启动

需要 Node/npm，以及带 C++20 编译器和 Windows SDK 的 Visual Studio／Build Tools；工具链探测、参数和独立测试见 [native 构建说明](native/README.md)。在仓库根目录的 PowerShell 中执行：

```powershell
# 构建游戏侧 Lua
npm ci
npm run build:nocopy

# 构建单 HTML 前端
npm --prefix console ci
npm --prefix console run build

# 构建原生 HTTP 插件
.\native\webconsole\build.ps1

# 退出游戏后部署三部分，再启动游戏
node scripts/deploy.js
```

默认自动探测游戏目录；也可用 `node scripts/deploy.js 'D:\SteamLibrary\steamapps\common\MonsterHunterRise'` 显式指定，或设置 `MHR_GAME_DIR`。

| 构建产物 | 游戏目录中的位置 |
| --- | --- |
| `reframework/autorun/mhw_rogue.lua` | `reframework/autorun/mhw_rogue.lua` |
| `native/webconsole/webconsole.dll` | `reframework/plugins/webconsole.dll` |
| `console/dist/index.html` | `reframework/plugins/console.html` |

这些文件由源码重新构建，不提交 Git。根目录的 `npm run build` 构建 Lua 并部署现有产物，**不会替你重新构建前端或 DLL**，修改它们后需先执行相应构建命令。

游戏加载插件后打开 **http://127.0.0.1:11777/console**。可用 `/api/health` 检查插件是否启动；状态是否有效还需查看网页的 Lua 心跳。

- 网页更新：重新构建、部署后刷新浏览器。
- Lua 更新：覆盖文件后，在安全状态使用 `REFramework → ScriptRunner → Reset scripts`，刷新网页并从新局开始；不保留进行中的肉鸽状态。
- DLL 更新：必须退出并重启游戏；Reset scripts 不会重新加载原生插件。

### 手机访问

插件监听 `0.0.0.0:11777`。手机连接可访问电脑的局域网，在浏览器打开 `http://<电脑局域网 IPv4>:11777/console`；地址使用电脑 IP，不是 `0.0.0.0` 或手机自己的 `127.0.0.1`。

若 Windows 防火墙未放行，在**管理员 PowerShell** 中添加一次同网段入站规则：

```powershell
New-NetFirewallRule -DisplayName 'MHR Webconsole LAN 11777' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 11777 -RemoteAddress LocalSubnet -Profile Any
```

当前没有登录鉴权，仅用于可信局域网，不要做公网端口转发。该规则只允许同网段；跨网段或 VPN 访问需要按实际网络单独配置。

### 开发与策划编辑

前端开发运行 `npm --prefix console run dev`，默认由 Vite 将 `/api` 代理到本机游戏服务 `127.0.0.1:11777`。开发服务器提供页面，游戏或独立联调环境仍需提供后端；`vite preview` 也不能代替游戏后端。

策划编辑器可修改奖励、难度曲线、怪物池、解锁与商店参数，并提供预览、差异确认、导入／导出及高级 JSON。提交后由 Lua 校验并持久化到 `reframework/data/mhw_rogue_config.json`；当前波次计划保持不变，运行规则及 runtime 设置留待下一局应用。界面预览和怪物目录不代表每种组合都已通过游戏内验收。

商店与游戏内窗口使用同一购买资格和交易路径：检查整备阶段、任务身份、集结位置、PT 与真实背包，执行后读取原生结果。补满、猫车恢复已接入，但原生效果仍需实机验收；不确定的交付会锁定交易，避免自动重复购买。

主要端点为 `GET /console`、`GET /api/health`、`GET /api/state`、`GET /api/results`、`GET /api/config` 和 `POST /api/command`。其中 `/api/config` 是磁盘持久覆盖文件，未必等同当前 Lua 生效配置；网页通过命令桥读取权威配置。命令使用单槽排队，并发占用返回 409。

协议、研究过程和验证边界见 [网页控制台研究记录](docs/research-web-console.md)；REFramework SDK 固定版本来源和许可证见 [第三方依赖说明](native/webconsole/reframework/README.md)。

## 默认路线与证据边界

`data/bossrush_reference.json` 保留了实际模板 603/101 的字段及差异、本地 14 个 BOSSRUSH
样本摘要和地图 10 的怪物 ID 集。快照含 78 个原版任务；加上旧原型后为 79 个。
603 的条件实际是 `[DEFAULT, EM1_HP, HP_EMx1]`、参数 `[0,65,50]`，不是天然的逐只讨伐出场。
M2a 显式测试 `EM1_HP=0`，其引擎时序必须实机核验。

默认池只使用地图 10 原生模板出现过的怪物，且修正 Valstrax 的名称映射。
原始实验池另存于 `data/unverified_monster_pools.json`，不自动加载。
地图出现证据不等于新组合、初始点、初始化参数全部可用；也不能据此宣称熊问题已消失。

多人联机状态同步、真正切换初始装备仍属于后续工作；商店已接入单人整备期真实道具发放，具体功能与验收边界见上方网页控制台说明。
猫车/剥取/集结与怪物死亡事件负责推进流程，HUD 不再提供模拟清怪或跳层按钮。

## 代码结构

| 路径 | 职责 |
|---|---|
| `src/core/run_core.ts` | PT、三选一、倍率、商店模型和一局状态 |
| `src/core/run_session.ts` | 真实事件驱动、集结、重进、去重、失败与降级 |
| `src/core/quest_plan.ts` | 名称→ID、怪表及目标条件的纯数据计划 |
| `src/game/quest_installer.ts` | 独立数组克隆、事务式发布、原生菜单/文本 |
| `src/game/native_runtime.ts` | 观测、作用域隔离、计时/结算/倍率 hook |
| `src/game/quest_transport.ts` | 原生柜台、单人选择、确认、出发、超时清理 |
| `src/game/sdk.ts` | 唯一宿主 API 声明入口 |
| `src/game/webconsole_bridge.ts` | Lua 命令信箱、状态发布、配置提交和交易回执 |
| `src/game/shop_window.ts` | 网页与原生窗口共用的购买资格和交付流程 |
| `console/src/` | Vue 控制台、策划编辑器与 HTTP 客户端 |
| `native/webconsole/` | C++ HTTP 插件、PowerShell 构建与独立测试 |
| `sdk-dump/` / `scripts/gen-*.js` | 固定版本 RTTI、SDK 类型/枚举生成 |

SDK 普通访问拒绝错误字段/参数；已核对但 dump 不完整的动态调用使用显式边界。
历史材料：[迁移方案](docs/migration.md)、[M1 实机记录](docs/runtime-2026-10-23.md)、
[原生刷怪/UI 调研](docs/research-spawn-and-ui.md)。历史“已通过”不代表本版 M2 已实机通过。

### 测试用战斗按钮（2026-10-24）

`MHR Arena Roguelike - M2` 面板顶部可切换 **Invincible: OFF/ON**，或点 **Kill all spawned bosses now** 对当前已刷出的大型怪物施加原生致死伤害。仅限单人 900101/900102；无敌默认关闭，重载也会关闭。模板 603 的基础攻击力仍然保留，开荒角色可开启无敌做流程验证。实机验证范围及最新限制见 [M2 测试说明](docs/m2-testing.md)。

游戏运行时复制脚本后，到 `REFramework → ScriptRunner → Reset scripts` 手动重载；单纯覆盖 autorun 文件不会自动重新执行。建议回村后重载。
