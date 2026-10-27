# 策划能力与 Rise 原生接口总表

研究日期：2026-10-27。目标版本：Rise 16.0.2.0；REFramework v1.5.9.1，发行包记录的提交为 `5bae4701396248a776c1de19f5be9552022295d5`。

本次结合 [M3 UI／商店／多人调研](research-m3-ui-native-shop-mp.md)、[原策划 V1.3](../../mhw-moddev/docs/ref/design-v1.3.txt)、现有 TS/Lua、游戏 TDB 导出、历史原生反汇编及 REFramework 固定版本源码。**新增的是离线研究和证据整理，没有操作游戏、安装探针或修改正式玩法。**

本文是目前材料覆盖范围内的候选能力清单，不是全游戏 API 的完备目录。没有 Capcom 原始源码；下文“原生代码”指游戏机器码及其反汇编，“框架源码”指公开的 REFramework C++。由名称推测的用途不称作已打通。

## 1. REFramework 到底怎样“反编译”

### 1.1 实际链条

```text
定位 RE Engine VM／运行时
  → 取得 TDB（类型数据库）、静态表、调用表
  → 恢复类型／继承／字段类型与偏移／方法签名
  → 解析方法的实际机器码地址
  → Object Explorer 浏览对象、导出 SDK 和 il2cpp_dump.json
  → 对机器码反汇编、关联已知方法调用
  → 必要时在 Ghidra／IDA 中分析控制流和伪代码
  → 在游戏中用少量事件确认调用协议
```

这不是把 EXE 直接变回原始 C#。TDB 提供名称和结构，机器码提供行为；伪代码也是分析产物。框架的 `get_function()` 给出函数指针，不能据此得知前置条件。[官方方法描述](https://cursey.github.io/reframework-book/api/types/REMethodDefinition.html)

### 1.2 固定版本源码依据

以下链接都锁定提交，不把目前主分支的新功能当成本机已有能力：

| 层 | 源文件与位置 | 实际做的事 |
|---|---|---|
| VM 定位 | [REContext.cpp](https://github.com/praydog/REFramework/blob/5bae4701396248a776c1de19f5be9552022295d5/shared/sdk/REContext.cpp#L25)，`VM::get / get_type_db / update_pointers` | 更新运行时指针，从 VM 中取得 TDB；不是读取 C# 源文件 |
| 类型与字段 | [RETypeDB.cpp](https://github.com/praydog/REFramework/blob/5bae4701396248a776c1de19f5be9552022295d5/shared/sdk/RETypeDB.cpp#L9)，`RETypeDB::get / find_type / REField::get_offset_from_base` | 枚举数据库、建立全名索引，区分字段相对基址与字段区偏移 |
| 方法地址 | [RETypeDB.cpp](https://github.com/praydog/REFramework/blob/5bae4701396248a776c1de19f5be9552022295d5/shared/sdk/RETypeDB.cpp#L422)，`REMethodDefinition::get_function` | TDB≥71 路径处理编码偏移，通过调用表／特征扫描找到基址或解码入口；失败可能返回空 |
| SDK 导出 | [ObjectExplorer.cpp](https://github.com/praydog/REFramework/blob/5bae4701396248a776c1de19f5be9552022295d5/src/mods/tools/ObjectExplorer.cpp#L998)，`generate_sdk` | 遍历 `tdb->numTypes`，导出结构、继承、方法、序列化信息，最终写 `il2cpp_dump.json`；导出受构建条件影响 |
| 原生调用关联 | [ObjectExplorer.cpp](https://github.com/praydog/REFramework/blob/5bae4701396248a776c1de19f5be9552022295d5/src/mods/tools/ObjectExplorer.cpp#L3150)，`populate_method_meta_info` | 用 `exhaustive_decode` 解码路径，解析 CALL 并在方法地址表中查名字；遇 CALL 跨过，不递归穷尽全游戏 |
| Lua 桥接 | [Sdk.cpp](https://github.com/praydog/REFramework/blob/5bae4701396248a776c1de19f5be9552022295d5/src/mods/bindings/Sdk.cpp#L1513) | 暴露方法、字段、对象和 hook；该版本 `get_methods` 会过滤空地址和 stub，所以“未枚举到”不等于游戏里绝对不存在 |

Object Explorer 有短反汇编与被调用方法视图，但不是完整高级语言反编译器。间接调用、虚调用、无 TDB 名称的函数和 hook 跳板，需要额外分析。官方也区分托管单例和只暴露部分接口的原生单例。[官方说明](https://cursey.github.io/reframework-book/#finding-game-functions-to-call-and-fields-to-grab)

### 1.3 本项目材料各自能证明什么

| 材料 | 本次核对结果 | 证据边界 |
|---|---|---|
| `sdk-dump/sdk_types.json` | 235 个选定类型 | 项目子集，**不是全游戏 TDB**；有些方法只存一个重载签名和重载数量 |
| `sdk-dump/Enums_Internal.hpp` | 原生枚举名和值 | 枚举标签不等于状态机协议 |
| `docs/evidence/2026-10-27-native-flow/metadata.json` | 5 个首领相关类型的当时字段偏移、方法地址 | 历史进程地址不能直接用于新进程 |
| 游戏目录 `rogue_inplace_native_metadata.json` | 10 个类型，补充装备箱／换装／装备备份方法 | 证明方法存在；大部分尚未调用验收 |
| 游戏目录 `rogue_native_gui_metadata.json` | 17 个根类型及继承链 | 能补商店、确认框、钱袋及库存接口；不证明原生商店接管成功 |
| `.local/save-editor/assets/mhrise/rszmhrise.json` | 250700 条序列化类型记录 | **RSZ 序列化 schema，不是完整运行时字段表，也不是内存偏移**；字段缺失不能证明运行时没有 |
| 旧反汇编 `.txt` | 每入口读取 0x2000 字节后线性解码 | 会跨函数、混入数据，入口可能已被 hook；不能把整份文本当一个函数体 |

本次把相关 TDB 和 RSZ 摘录存入 [证据目录](evidence/2026-10-27-design-api/)，保留输入 SHA-256，便于脱离 `.local` 检索。用 [收集脚本](../scripts/collect-design-api-evidence.py) 可重新生成。证据中的地址只是历史记录，运行时需重新解析完整签名。

## 2. 策划缺口与可利用能力

标记：**实测**＝现有证据有游戏行为；**元数据**＝类型／签名／字段已发现；**代码**＝本次直接核对项目或框架源码；**推断**＝下一步假设，尚无行为保证。

| 策划能力 | 可利用的原生入口 | 当前判断 | 下一项最小验收 |
|---|---|---|---|
| 不换图连续波次 | `QuestManager.updateBossEnemy / updateExtraEnemyCommon`；`EnemyManager.createEnemySetInfo` | 实测：新增怪种、空场续怪、槽位与游标复用 | 补同时双怪两只存活及长期循环 |
| 稳定同时双怪 | `_BossSet / _BossSetNoTbl / _BossSetCond / _BossLoadStartOk / _BossLoadDone`；`checkNextEnemyAppearCondition` | 首进同时出场有成功记录，续波漏第二只 | 对比成功／失败第二槽条件和阶段，不直接强跳 CreateEnemy |
| 标准血量与难度 | `getQuestEnemyNando(emSetId)` → `QuestEnemyNando`；难度表查询与角色倍率方法 | 元数据：完整难度参数链有入口；当前乘法 hook 无法纠正错误基础值 | 相同怪种原生首进／追加时，逐层对比索引、表号、倍率、最终 HP |
| 正常体型 | `QuestEnemyNando.Scale / ScaleWave`；`getBossRandomScale / setupBaseScale` | 元数据，极小怪根因未定 | 同步采难度体型参数和角色总缩放，区分来源 |
| 清场、回收、长局 | `registerRequestDestroyEnemyList / updateDestroyEnemy / destroyEnemy` | 元数据；现有记录仍持续增长 | 单 UID 销毁、剥取完成后槽位释放、记录是否可安全回收 |
| 通用死亡／捕获／奖励 | `questEnemyDie`、`isCapture / isDieBehaviorActive / getHpVital` | 实测有非目标怪不进任务目标 UID 列表 | 同种双怪、捕获、回调缺失时仍一次结算 |
| 零物资开局／返回恢复 | `ItemPouch.saveToBackupInventory / loadFromBackupInventory / clear / load` | 元数据，已有原生备份候选 | 非空袋快照→清空选定分类→恢复→逐项比对；禁止把物资倒回永久箱代替恢复 |
| 初始装备／局内装备 | `EquipDataManager.saveToBackup / loadFromBackup / changeEquip / applyEquipMySet` | 元数据；新增 R10 太刀已由用户验证 | 低级装切换、技能和模型刷新、结束恢复，包含珠子护石 |
| 装备抽取／掉落 | `EquipBox.tryAddGameItem(WeaponId, EquipmentInventoryData, Boolean)` | 实测武器入箱；临时生命周期尚缺 | 抽取只创建一个有追踪标识的装备，退出清理且不留永久复制品 |
| 弹药／素材补满 | `ItemPouch.tryAddGameItem(ItemId, Int32)`；`getRemainingCount`；物品携带上限 | 元数据支持批量，当前发货代码明确只接收 1 件 | 空袋／已有一部分／满袋／格子满四种情况，按读回决定交易结果 |
| 基础砥石无限 | `ItemPouch.checkInfiniteFlag(ItemId)`；`ItemUserData.Param._Infinite` | 元数据，适合核对 Rise 原生规则 | 基础砥石可用，鱼鳞仍消耗；不全局跳过道具消耗 |
| 猫车恢复／共享猫数 | `QuestManager.getDeathNum / setDeathNum(UInt32) / notifyDeath / setQuestFail` | 元数据＋已有核心计数；同步与失败链待核对 | Core 余额与原生猫数不冲突，购买后第三次猫车规则正确 |
| 单轮攻／防／会心增益 | `PlayerBase.calcTotalAttack`；PlayerData 加成字段；会心 getter 候选 | 社区代码有先例，百万攻击实验不构成可靠数值验收 | 小幅加成、下一波消费一次、换装／猫车／结束后正确复原 |
| 商店与原生 UI | `GuiItemShopFsmManager`、`DisplayItemData`、`GuiManager` 确认窗 | 元数据＋现有 ImGui 真实物品发放 | 先打开／关闭原生商店，再注入商品，最后研究支付链 |
| 多人同步 | `netSendBossLoad / netRecvBossLoad`；`makeSyncNormalQuest / applySyncNormalQuest`；怪物 master 接口 | 元数据，不能仅加自定义广播就宣称完成 | 房主追加怪，客户端同 UID／种类／难度、死亡、清理一致 |
| 中高阶／特殊怪 | 原生模板与地图证据、怪物专属行为树和参数 | 低层之外未整体验收；World 特殊怪不在 Rise 同一资源体系 | 先形成 Rise 对照怪池，再逐种验 AI／寻路／场地依赖 |

## 3. 首先值得深挖的代码链

### 3.1 续波倍率／体型：追 `getQuestEnemyNando`，不要继续盲补倍率

已找到的 TDB 签名：

```text
snow.QuestManager.getQuestEnemyNando(System.Int32 emSetId)
  → snow.quest.QuestEnemyNando
snow.enemy.EnemySetInfo.get_EmSetId() → System.Int16
snow.enemy.EnemySetInfo.get_SetupParam() → EnemyManager.EnemySetupParam
snow.enemy.EnemySetInfo.setEnemySetupParamMaster(EnemyCharacterBase)
snow.enemy.EnemyManager.getEnemyDifficultyRateVital(Int32 emIndex, VitalCategory, NandoGetType)
snow.enemy.EnemyCharacterBase.getDifficultyRateVital(VitalCategory, NandoGetType, Int32 partsNo)
```

`QuestEnemyNando` 的 RSZ 字段为 `Vital / Attack / NandoWave / Scale / ScaleWave / Stamina / Parts / Other / MultiRate`。`NormalQuestDataForEnemy.Param` 则含 `_VitalTbl / _AttackTbl / _PartsTbl / _OtherTbl / _StaminaTbl / _Scale / _ScaleTbl / _Difficulty / _BossMulti` 数组。这些是难度表／枚举参数，不能把整数表号当作最终乘数。

**代码事实**：当前 [inplace_waves.ts](../src/game/inplace_waves.ts) 给新怪创建 `BossSetParam`，复制位置、路线、子类型等；`BossSetParam` 自身只有额外的 `_RouteNo`，基础 `EnemySetParam` 里也没有上述难度字段。代码没有通过这次参数复制显式设置新的 `QuestEnemyNando`。相比之下，首进任务走的是 [quest_installer.ts](../src/game/quest_installer.ts) 的任务表发布流程。

**推断**：新 `EmSetId` 与原任务怪物参数索引的映射可能走了默认值／回退值。它比“倍率 hook 少乘了一次”更值得优先调查，但尚不能断言是越界或默认 0。

要沿下面几个点追踪一次正常首进与一次追加：

1. `createEnemySetInfo` 返回的新 EmSetId、UID、怪种；调用 `getQuestEnemyNando` 的实际实参。
2. 返回难度对象的各字段；对应 `_VitalTbl / _Scale` 等数组的选中项。
3. `EnemySetInfo.setupEnemy / setEnemySetupParamMaster` 如何把它写入 SetupParam。当前 RSZ 中 SetupParam 没字段，不代表运行时没字段，需要补 TDB。
4. 角色 `get_EmTypeIndex / get_VitalNandoWave / getDifficultyRateVital` 与最终 `getHpMaxVital`。
5. `get_BaseScale / get_RandomScale / get_QuestDesignationScale / get_UniqueScale / get_TotalScale` 的值。

若定位到参数解析层错误，应在**新记录初始化时提供正确难度上下文**，并保持每层倍率只施加一次。不能简单用 2.14/0.1 的固定比值补偿所有怪。最终验收是标准样本 HP、当前波次 HP、伤害与体型都符合设计，不以“hook 被调用”验收。

### 3.2 同时双怪：区分三种编号，观察第二只被挡在哪一层

已有反汇编和实测支持：`updateBossEnemy` 消费任务出场表，并调用 `updateExtraEnemyCommon`；状态 5/6/7/8 分别对应请求加载／等待加载／同步等待／创建。旧 `updateEnemySetInfoQuestHost` 消费的是小怪列表，不能用于解释首领出场。[历史原生证据](evidence/2026-10-27-native-flow/README.md)

必须分开记录：**任务槽号**（`_BossSet` 下标）、**顺序表位置**（`_BossSetNoTbl` 游标）、**EmSetId／UID**。`_BossSetCount` 不等于活怪数量。`_BossSetCond` 在引擎里究竟按哪个编号读取，需要以分支为准，不能靠字段名假设。

当前后端同时模式会一次登记两只、发布两项顺序表，重启 RequestLoad；顺序模式则先等待已发出 UID 全部结束。**代码事实**：tick 还有“已存在活怪则等待”的公共扫描，但它位于下一批注册前。一次同时批次的两只已经全部登记，因此不能直接把这个扫描当作“已登记第二只不出现”的根因。

下一步只采阶段变化：当前顺序项、第二槽 condition／State／EmSetId、LoadStartOk／LoadDone、SetStatus／OwnerEnemy、`checkNextEnemyAppearCondition` 结果。由此区分：未被调度、等待条件、加载未完、创建失败、已生成但不可见。先拿成功首进的第二槽作对照，不再凭状态名称逐个写值。

### 3.3 清场和记录增长是两个问题

`EnemyManager` 提供 `registerRequestDestroyEnemyList(EnemyCharacterBase)`、`updateDestroyEnemy()`、`destroyEnemy(EnemyCharacterBase)`、`destroyEnemyGameObject(EnemyCharacterBase)`、`allDestroyEnemyInstance()`；角色提供 `requestShellDestroyAll()`、`dieDirectErase()`、`setExceptionalDie(...)`。

这些是**元数据候选**，并非全部可互换：直接消失不等于讨伐，销毁 GameObject 不等于释放队列记录，销毁本体也不保证场地效果和专属管理器清干净。优先从原生“请求销毁→执行销毁→释放引用”找完整生命周期，剥取结束后再回收。

当前 `_EnemySetInfoList` 持续追加，上限保护为 512；任务槽复用没有证明记录可无限回收。不要直接 List.RemoveAt：`getEnemySetInfo(emSetId)` 的索引协议可能依赖位置，原生记录号还是 Int16。应先查分配器／删除调用方，验证剩余记录、加载缓存、UID 均不被破坏，再讨论无限局。

## 4. 局内物资、装备和恢复

### 4.1 道具袋已有原生备份，不必先手工实现所有字段复制

已找到：

```text
ItemPouch.saveToBackupInventory()
ItemPouch.loadFromBackupInventory(System.Boolean isExceptWireJumpInsectItem)
ItemPouch.get_BackupInventoryDataList() → ItemInventoryData[][]
ItemPouch.clear(ItemPouch.InventoryTypes)
ItemPouch.load(ItemPouch)
ItemPouch.getInventoryDataList(InventoryTypes)
ItemInventoryData.copy(ItemInventoryData)
ItemInventoryData.set(ItemId, UInt32 num, Boolean autoClear)
```

用途：零物资开局、道具购买后的临时库存、结束恢复。道具袋还分普通、临时、弹瓶、常驻、翔虫、狗袋等分类；不能一把清空所有分类，否则可能丢掉 Rise 原生基础工具。`loadFromBackupInventory` 的排除参数也表明恢复语义有例外。

先反汇编备份／恢复，查游戏何时自动覆盖备份；原生备份是进程内状态，不自动解决崩溃恢复。可借用它做短实验，正式隔离还应有自有的、带角色和局标识的恢复记录，并验证自动存档前后的顺序。回村补给、道具箱、预设、狗袋和拾取都可能绕过“零开局资源”，要一并定规则。

### 4.2 装备不止有“往箱里塞武器”

本次在装备元数据中发现：

| 入口 | 用途 | 尚未解决 |
|---|---|---|
| `EquipDataManager.saveToBackup / loadFromBackup` | 原装备备份／恢复候选 | 覆盖范围、触发时间和游戏是否覆盖它 |
| `getEquipData / getEquipWeaponData / getEquipArmorData / getEquipTalismanData` | 读取原始装备集 | 珠子、护石、傀异强化和替换技是否完整 |
| `changeEquip(EquipmentInventoryData)` 及带 `PlEquipTypes` 重载 | 原生换装入口 | 营地外可用性、刷新技能／模型／多人同步 |
| `reloadPlayerModel(Boolean, Nullable<PlayerIndex>) / requestPlModelLoad(PlayerIndex)` | 原生模型刷新候选 | 应由换装调用链决定是否还需手动调用，不能全部乱调 |
| `applyEquipMySet(Int32)`／`applyEquipMySet(PlEquipMySetData)` | 套装应用 | 不应覆盖用户已有预设；自建对象的完整构造待查 |
| `EquipBox.saveToBackupInventory / loadFromBackupInventory` | 装备箱备份候选 | 全箱回滚可能覆盖期间正常变化，不能默认与穿戴备份同义 |
| `EquipBox.subEquipment(EquipmentInventoryData)` | 临时装备退场清理候选 | 需先卸装，核对预设引用、收藏／锁定、排序与库存索引 |

RSZ 中 `snow.equip.PlEquipMySetData` 保存 `_InventoryIndexList`、备份数据、动作 ID 和红蓝书替换技。**只保存武器 ID 不足以恢复原配装**；对装备箱做增删排序后，原库存索引也可能失效。

已验证的 R10 太刀按钮使用：

```text
EquipBox.tryAddGameItem(
  snow.data.ContentsIdSystem.WeaponId,
  snow.data.EquipmentInventoryData,
  System.Boolean)
```

这是永久箱发放先例，不是局内装备系统。正式抽取需要自有奖池和唯一所有权记录，结束时先恢复原装，再准确删除本局生成条目。防具、护石、珠子等需分别核对重载，不能把武器方法推广成“所有装备已支持”。[现有实测按钮](../reframework/autorun-probe/rogue_test_weapon.lua)

### 4.3 存档隔离需要追真正的保存入口

`DataManager` 和 `EquipDataManager` 暴露 `registerDataOnSave / registerDataOnLoad / onLoad`，DataManager 还有 `initializeBeforeSave`。这些名称是序列化参与点的证据，**不证明它们就是磁盘提交函数或安全的全局禁存档开关**。

RSZ 中发现 `SnowSaveService` 类型，但其 schema 只给出不透明占位字段；当前 TDB 子集也不覆盖完整保存服务。下一轮需补该类型及实际调用链，区分自动保存请求、序列化快照、磁盘写入完成。断线、重载 Lua、游戏崩溃、恢复失败都必须有可重试且不重复发物的恢复路径。

## 5. 商店和单轮成长

### 5.1 批量补满：接口不是瓶颈，交易层还没接完

游戏 `ItemPouch.tryAddGameItem(ItemId, Int32 addNum)` 支持数量参数，`ItemInventoryData.getRemainingCount / getRemainingCountBase / isFull` 可辅助计算；RSZ `ItemUserData.Param._PlMaxCount` 是携带上限候选。空槽时怎样取得该物品上限，仍需补 `ItemData` 到参数的链，不能临时造假库存来问剩余容量。

当前 [item_grant.ts](../src/game/item_grant.ts) 明确 `count !== 1` 即拒绝，故“直接解锁 fill”还需要真实代码修改和验收。建议规则：算本次缺口→一次原生添加→读回实际增量→提交 PT。原生返回 void；满袋、格子不足、部分添加、抛错但已写入等情况必须区分，尤其不能盲目重试。不把未核对的 World 携带上限和弹种表照搬到 Rise。

### 5.2 猫车恢复不是已经证明的“只加 Core 一点”

`QuestManager.getDeathNum()`、`setDeathNum(UInt32)`、`getQuestLife()`、`notifyDeath(Int32)`、`setQuestFail(FailReason)` 是值得追的原生入口。当前会话观测原生死亡计数，并存在原生失败链；只把 `CartsLeft+1` 可能仍被原生三猫结束，也可能让下一次轮询覆盖 Core 效果。

需核对到底采用“原生计数减一”还是“失败阈值／会话偏移”；购买一次后，原生 UI、Core、失败检查必须一致。多人还涉及广播和队伍状态。因此，另一份调研对此的“纯 Core、无游戏效果”判断应降为待验证。

### 5.3 攻防／会心：有先例，但要先验证小数值与生命周期

社区 [Buffer Character.lua](https://github.com/Bimmr/Monster-Hunter-Rise-Reframework-Scripts-/blob/main/Buffer/autorun/Buffer/Modules/Character.lua) 使用 PlayerData `_AtkUpAlive / _DefUpAlive`，会心部分 hook `snow.equip.MainWeaponBaseData.get_CriticalRate`。本次也核对了已下载的该脚本；这是社区实现证据，字段和 hook 在本机仍需核对。

本机 TDB 已有 `PlayerBase.calcTotalAttack()`；现有百万攻击实验已经说明“写进字段”与“最终战斗值生效”不能画等号。单轮服务应先用小幅增益，记录最终攻防／会心与实际战斗结果；通过玩家身份和波次 token 限定作用对象，波次开始消费、结束撤销。需处理药品叠加、原生重算、换装、猫车和玩家对象重建。不要把缓存的旧字段值长期每帧写回，覆盖正常游戏变化。

### 5.4 原生商店：打开、商品列表、支付是三条不同链

核对 GUI 元数据后确认：

- `GuiItemShopFsmManager` 有 `openItemShop / closeItemShop / isOpenItemShop`，继承链提供静态实例入口。任务中能否正确打开仍未证明。
- `set_BuyItemListAll / ToPlayer / ToEnemy / Other` 是列表 setter；打开／切页时会不会重新生成列表，需要查其生命周期。
- `DisplayItemData.ctor(ItemShopDisplayUserData.Param, ItemShopBase.PaymentTypes)` 已存在，还有 `getPurchaseStatus / checkPaymentLimit / getPrice / getMaxPurchaseableNum`。
- `DisplayItemData` **还有 `get_HandMoney / set_HandMoney`**，关联 `snow.data.HandMoney`；该类型暴露 `get_Value / isEnough / addMoney / saveToBackup / loadFromBackup`。这是另一份总结未展开的支付对象候选。
- `GuiItemShopBuyYNFsmAction` 当前导出的方法主要是 `start(ActionArg)` 和设置弹窗文字；单凭它存在，不能证明扣费就在这里。

可研究“自有 HandMoney 对象驱动购买检查”是否可行，但不能据 setter 就断定可替换 PT：最终扣费、发货、刷新、限购可能分别访问真实 DataManager 钱包。`addMoney` 的有符号参数也不能被当作已证明的任意扣费协议。需顺藤摸瓜至 `DataManager.buyGameItem / tryBuyGameItem` 等实际交易点，证明真实 Zenny／点数不变，再接 PT 单次提交。

原生抽奖／炼金菜单可参考表现形式，不等于它能发任意武器。要先验证数据模型适配，而非把护石炼金 RNG 当装备奖池。

### 5.5 ImGui 可先改善，但结论限于这个发行版

已核对固定提交的 [ImGui.cpp](https://github.com/praydog/REFramework/blob/5bae4701396248a776c1de19f5be9552022295d5/src/mods/bindings/ImGui.cpp)：存在字体、样式、表格和绘图列表等绑定；未发现 `imgui.image`／tab bar 的绑定。这支持现有 UI 主题化路线，但不等于“所有 REFramework 扩展都不能画贴图”。原生插件或另一渲染路径是额外成本，不能归为当前 Lua API 已有能力。动画也可自行计时实现，并非绝对做不到。

## 6. 多人：原生同步层值得利用，但比“广播种子”多一整层

### 6.1 已找到的接口与包结构

TDB 有以下方法：

```text
QuestManager.netSendBossLoad(LoadPacketCmdType, UInt32)
QuestManager.netRecvBossLoad(NotifyQuestBossLoad, Int32)
QuestManager.makeSyncNormalQuest(SyncNormalsQuest, Boolean, Int32)
QuestManager.netRecvSyncNormalQuest(SyncNormalsQuest, Int32)
QuestManager.applySyncNormalQuest(SyncNormalsQuest)
QuestManager.netSendSyncDiscoverNextBoss(UInt16)
QuestManager.netRecvSyncDiscoverNextBoss(SyncDiscoverNextBoss, Int32)
QuestManager.applySyncDiscoverNextBoss()
EnemySetInfo.receiveSetupPacket(...) / setEnemySetupParamMiddle(EnemyLateJoinSyncPacket)
EnemyCharacterBase.get_IsMaster() / get_NetworkSelfIndex()
EnemyCharacterBase.changeMasterToQuestHost() / setupSyncParamMaster()
```

RSZ `NotifyQuestBossLoad` 含 `_Type / _BossSetNo / _ExtraSetCount`；`SyncDiscoverNextBoss` 含 `_ExtraSetCount / _DiscoverNextEmSetSlot / _DiscoverNextEmSetId / _EmGenId / _TourBossLoadQuestHost`。这说明原生协议包含槽位、出怪记录号、生成号和加载主机信息，值得复用；但这些包各自适用探索／普通／百龙哪条路径，必须查调用方，不能串用。

**推断**：可以让自定义通道同步肉鸽决策，原生通道同步怪物实体与加载；前提是各客户端正确建立相同记录和参数上下文。相同随机种子只能保证选项计算一致，不能自动保证原生 EmSetId／生成号一致。

### 6.2 对先前调研的补充

- 任务房主与每只怪的 master 是两个概念。TDB 存在更换怪物 master 的方法，所以“仅房主挂数值 hook”是否正确必须实测，不能先定死；否则实体权威转移后可能漏算。
- 独立背包有利于个人资源，但不是“天然多人安全”的证明。重复网络指令、重连、发货读回、PT 扣款、房主确认和部分失败仍需事务标识与去重。
- 主机权威不能只同步初始 seed；还要同步已选项、层数、当前模式、共享猫车、解锁状态、波次 token 和结束原因。晚到包／重复包不能重新生成怪或发奖励。
- 当前 native backend 仍拒绝 online，`quest_transport` 也有 solo 自动接取假设。需要先形成 host/client 职责，不要删除 solo 检查后直接联机。
- 本轮没有核实 SPL 自定义包在当前版本的 API、安装依赖和可靠性，因此它仍是候选；聊天命令也不是已验证传输层。
- 禁止中途加入、房主退出结束，属于策划功能，仍需 Lobby／连接事件和权限接口。当前材料不完整，列为下一轮定向 TDB 导出目标。

最小验收：两台机器同版模块→房主选单怪→客户端同 UID／怪种／HP→击杀只发一次奖励→同时双怪→模拟 master 变化与断线→双方可靠结束和恢复资源。原生任务 loader 的社区联机先例仅能证明任务分发思路，不证明自定义动态续波协议已适配。

## 7. Rise 与原策划的能力边界

原策划是 World／Iceborne。聚魔诱导、煌黑龙、黑龙、历战王和其地图机关不能只靠 Rise TDB 方法名直接获得。需明确哪些目标改为 Rise 的探索／BOSSRUSH 调度、哪些换成 Rise 终盘怪，哪些必须新增资产和行为实现。

“历战王地图绑定弱、零适配成本”等原策划判断也不应当作已验证事实。Rise 侧中高阶怪物需要逐种核对地图 10 模板、落点、路线、AI、专属场地对象、体型和参数。新增怪种的基本模板证据见 [bossrush_reference.json](../data/bossrush_reference.json)，但模板出现不等于完整战斗已测。

层数、PT、选择模式、解锁链、随机奖池和结算展示适合继续留在 Core；不需要为了“更原生”把所有逻辑塞进游戏 FSM。原生接口主要负责可靠的实体、战斗、库存、换装和同步。

## 8. 后续研究顺序与交付门槛

| 优先级 | 下一步代码调查 | 为什么先做 | 验收证据 |
|---|---|---|---|
| P0 | `getQuestEnemyNando`、`setupEnemy`、SetupParam、最终 HP／Scale | 关系到每一波数值是否真实 | 同种首进与续波对照，追到第一个偏离点 |
| P0 | 同时双怪第二槽的条件、加载、创建分支 | 当前玩法选项不能稳定兑现 | 同场两只不同 UID 同时存活，均按预期 HP，一次奖励，无回退 |
| P1 | 批量补满和交易去重 | 补齐远程续航，入口已有 | 空／半满／已满／无空格，准确发货与扣款 |
| P1 | 道具／穿戴／装备箱备份的原生调用方，存档链 | 建立肉鸽资源约束，结束可恢复 | 完整往返对比，加退出／重载／中断恢复 |
| P1 | 原生死亡数与失败链 | 猫车恢复服务不能只改显示 | 购前／购后死亡阈值和原生 UI 一致 |
| P2 | 小幅攻防会心效果、临时装备生命周期 | 补成长闭环 | 一波生效、下一波撤销、无永久残留 |
| P2 | 请求销毁与记录分配／回收 | 才能声称长局或无限循环 | 记录数量趋势、引用与槽位无泄漏、反复循环稳定 |
| P3 | 原生商店打开→列表→支付调用链 | 体验升级，不阻塞当前 ImGui 商店 | 可逆关闭、商品正确、PT 只扣一次、原币不动 |
| P3 | 原生同步、master、Lobby、保存服务定向 TDB | 多人和失败恢复的证据还不足 | 双端实体／会话／交易一致，断线恢复 |

调查纪律：先导出目标类型和完整重载，记录版本、PID、模块基址、时间与哈希；Ghidra／IDA 使用 RVA 并辨认原始入口／跳板，不复用历史绝对地址。针对疑点采样，事件有界缓冲，状态变化才记录，离开实验即关闭。不要重启每秒全量几 MB 快照，也不要每帧重复反射搜索方法。

下一批需要补的类型：`QuestEnemyNando`、`EnemyManager.EnemySetupParam`、`PlayerData`、`MainWeaponBaseData`、`ItemData` 及其参数访问链、`ItemShopDisplayUserData.Param`、`HandMoney`、`SnowSaveService`、`LobbyManager`，以及上述原生同步包的运行时完整字段。当前有的只是 RSZ schema，不能据此填写运行时偏移。

每项实验必须把“接口存在→前置条件→调用结果→读回／战斗效果→恢复”走完。若只得到方法名，更新为候选；若只得到一次成功，不外推为全怪池、无限局或多人完成。
