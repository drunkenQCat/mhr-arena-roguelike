> 2026-10-24 商店/GUI 部分已复核并有重要更正（原生选项菜单先例、设施入口与引用误判），以 [新调研](research-native-shop-gui.md) 为准。本页保留历史调查记录。

# 调研：控制出怪 & 原生 UI 调用（2026-10-23）

> 两个问题：①社区里有没有类似我们"控制出怪"的思路？②正规的 MHR mod 怎么写 UI、
> 有没有调用游戏原生 UI（比如商店）的先例？

## 1. 控制出怪：社区现状

### 1.1 核心结论

**没有任何社区 mod 实现过"运行时动态生成战斗怪"。** 三类现成实现覆盖了"数据改怪"和
"视觉摆模型"两个极端，中间地带（我们的波次系统）没人做过——但拼图是齐的：

| 实现 | 做法 | 对我们的价值 |
|---|---|---|
| [RiseQuestLoader/Editor](https://github.com/Fexty12573/RiseQuestLoader)（本地 `.local/`） | native DLL hook 任务加载四件套（getQuestTextCore/makeQuestNoList/...），从 JSON 装任务；编辑器可改 `_BossEmType` 7 怪槽 + SpawnCondition/Param | **我们的 Lua 安装器与它同构**（已实机验证）；怪槽/出怪参数在任务数据里可写 |
| [EMV-Engine Enemy Spawner](https://github.com/alphazolam/EMV-Engine)（本地 `.local/emv-engine/`） | 从 `snow.enemy.EnemyDataManager:get_EnemyDataTable()` 取 prefab，走 `instantiate(vec3, quat, folder)` 摆 GameObject | **反面教材**：生成的是无 AI、无战斗逻辑的模型假人——印证 MHW NewUnit 实验结论：绕过引擎生成管线 = 不可行 |
| RiseSpawnEditor（同上仓库） | 编辑地图出怪文件（EnemyLot，探索期静态出怪点） | 对"斗技场固定地图"用处小；属于地图数据层 |
| AutoQuest（本地 `.local/autoquest-study/`） | 运行时枚举/过滤/操纵任务板（QuestDataDictionary 可写已验证） | 任务板操纵模式可复用（开局接任务自动化） |

### 1.2 本轮关键发现：`BOSSRUSH = 8` 任务类型

游戏枚举 dump（`<game>/Enums_Internal.hpp`，REFramework 生成）+ RiseQuestEditor 的
`QuestData.cs` 双源证实 `snow.quest.QuestType` 是**位标志**：

```
HUNTING=1  KILL=2  CAPTURE=4  BOSSRUSH=8  COLLECTS=16  TOUR=32
ARENA=64  SPECIAL=128  HYAKURYU=256  TRAINING=512  KYOUSEI=1024
```

- **BOSSRUSH**（Boss-rush Quest，编辑器里明确有这个 checkbox）= 斗技场"连续讨伐"类任务：
  **引擎原生支持"清完当前怪自动刷下一只"**——正是 MHW "Sequential spawn" 的等价物。
- 我们现在的 TOUR（探索，熊的来源）出怪行为未定义；ARENA 是斗技场单挑。
- QuestType 可以组合（editor 用 HasFlag/|=）。

### 1.3 路线建议（M2 spike 顺序）

- **Route A（首选）**：克隆一个 BOSSRUSH 斗技连战任务 → 实机观察引擎行为
  （是否自动连刷、计时/猫车规则、场地）→ 若成立，**每层开始时运行时改写当前任务的
  怪表**（QuestDataDictionary 写入已验证），波次系统由引擎驱动，零自研生成管线。
- **Route B**：维持 TOUR + 运行时改地图出怪 set（需逆向出怪加载，重，不推荐先做）。
- **Route C（保底降级）**：换任务链（每层一张任务，安装器已具备，~20s 加载 ×N）。
- **不做**：EMV 式 prefab 摆放（无战斗逻辑）。

Spike 验收：进入克隆的 BOSSRUSH 任务，讨伐第一只后 ≤10s 内引擎自动刷出第二只（不同怪）。

## 2. UI：正规写法与原生 UI 调用先例

### 2.1 mod 自己的 UI（社区标准）

- **REFramework imgui**（我们在用）就是社区标准：`re.on_draw_ui` + `imgui.*`，
  画在 Script Generated UI 树下。杂项：v1.5.9 默认字体无 CJK（已定案英文 UI）。
- 现成菜单库：[Bolt-Scripts/MHR-InGame-ModMenu-API](https://github.com/Bolt-Scripts/MHR-InGame-ModMenu-API)
  （[Nexus #1292](https://www.nexusmods.com/monsterhunterrise/mods/1292)）——封装好的
  imgui 菜单组件，M3 商店 UI 可考虑借用其样式约定，不必引依赖。
- 官方级示例：[cursey/mhrise-scripts](https://github.com/cursey/mhrise-scripts)
  （REFramework 脚本系统作者本人的脚本集）。

### 2.2 调用游戏原生 UI（如商店）：路径存在，无现成完整先例

- 入口单例：`snow.gui.GuiManager`；各界面有独立 **FSM 管理器**，枚举 dump 里直接可见：
  - `snow.gui.fsm.itemshop.GuiItemShopFsmManager`（**道具商店**）
  - `snow.gui.fsm.pointshop.GuiPointShopFsmManager`（点数商店）
  - `snow.gui.fsm.questcounter.GuiQuestCounterMenu`（任务柜台）
  - `snow.gui.GuiItemBoxWindow`（道具箱）
- 调用模式（社区佐证）：`GuiManager:executeInterfaceID(<InterfaceID>, ...)`；
  FSM open 模式见 [Waester 的 gist](https://gist.github.com/Waester/7d6e080d1f4695feb683d997132f872b)
  （`GuiTitleMenuFsmManager:openTitle`）。
- **未发现公开 mod 完整调起原生商店**（QoL mod 常调地图/菜单，商店无人做过）。
  InterfaceID 枚举不在枚举 dump 里 → 需要运行时探测。
- **M3 首个 spike**：写 `gui_probe` 脚本，运行时枚举
  `sdk.find_type_definition("snow.gui.GuiManager"):get_methods()` 与静态字段，
  拿到 InterfaceID 常量表与 execute/open 系方法签名，再实测打开 itemshop。

### 2.3 对我们商店的落地含义

M3 商店的稳妥路线是**imgui 自绘面板**（数据全部在 RunCore，下单走道具写入），
原生商店 UI 作为"体验加分项"按 2.2 的探测结果决定要不要做——不阻塞主线。

## 3. 参考链接

- [mhvuze/MonsterHunterRiseModding wiki](https://github.com/mhvuze/MonsterHunterRiseModding/wiki)（Custom Quest / Spawn Editing）
- [alphazolam/EMV-Engine](https://github.com/alphazolam/EMV-Engine)
- [cursey/mhrise-scripts](https://github.com/cursey/mhrise-scripts)
- [Bolt-Scripts/MHR-InGame-ModMenu-API](https://github.com/Bolt-Scripts/MHR-InGame-ModMenu-API)
- [REFramework docs](https://refdocs.praydog.com/examples/Example-Scripts.html)
- 本地快照：`.local/emv-engine/`、`.local/mhrise-scripts/`、`.local/RiseQuestLoader/`、`.local/autoquest-study/`
