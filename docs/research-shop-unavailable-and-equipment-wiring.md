# 商店 unavailable 商品与装备/道具袋操作接线调研

研究日期：2026-10-29。目标版本：Rise 16.0.2.0 / REFramework v1.5.9.1。
回答四个问题：**① 商店里 unavailable 的东西怎么解决（猫车恢复现状、翻盘服务接线）；
② 开局骨套/铁套怎么自动穿到玩家身上；③ 全身装备怎么卸回装备箱；④ 道具袋怎么掏空到道具箱。**

标记沿用总表约定：**实测**＝本仓库有游戏内执行证据；**元数据**＝TDB/RSZ 签名已核实、未执行；
**社区**＝第三方脚本先例，本机待核对；**推断**＝假设。

## 0. 结论速览

| 问题 | 结论 |
|---|---|
| 商店哪些东西 unavailable、为什么 | 只有 `shop_window.ts:58-60` 一道闸：`mode==="service"` 且 id ≠ `cart_restore` 的商品全部标 `canBuy=false`。物品类商品（弹药/素材）在袋不可读或非交易期也会临时 unavailable。 |
| 猫车恢复（nativeDeaths） | **已接线待实机验收**。`native_cart.ts` 走 `QuestManager.getDeathNum()/setDeathNum()`，与状态快照里的 `nativeDeaths` 字段同源；剩余风险见 §2.1。 |
| 单轮攻/防/会心 | PlayerData `_AtkUpAlive/_DefUpAlive` 字段写值 + `MainWeaponBaseData.get_CriticalRate` hook（社区先例，本机字段待核对）。按"购买→下一波生效→波末撤销"接线，见 §2.2。 |
| 装备抽取 gacha_1-4 | `EquipBox.tryAddGameItem` 有武器/防具/护石/虫笼四个重载，武器入箱已实测；防具发放同链路，需自有奖池与追踪清理，见 §2.3。 |
| 开局自动穿装 | **实测闭环**：`EquipBox.tryAddGameItem(PlArmorId, 槽位)` 补箱（显式重载名）+ 直接写 `PlEquipPack._InventoryIndexList` 数组元素换装。合金套=系列9、骨制套=系列146 已用名字读回证实；`changeEquip` 在村庄是无效摆设，见 §3。 |
| 全身卸装回装备箱 | **实测**：`PlEquipPack._InventoryIndexList` 是 System.Int32[]，`arr[i]=-1` 即卸装（已实测，全身清空的 pack 就是这样来的），`arr[i]=槽位号` 即穿装。装备箱条目本来就在箱子里，不存在搬运。见 §4。 |
| 道具袋掏空到道具箱 | **实测闭环**：`DataManager.sendInventory(槽, 65536)` 整堆送入道具箱、读回双验证、`revertSendInventory` 完整回滚（药 10 个：袋 10→0→10，箱 17→27→17）。见 §5。 |

## 1. unavailable 的产生机制（一处闸门，两处临时条件）

`ShopWindow.catalogue()`（[shop_window.ts:41-67](../src/game/shop_window.ts)）是原生 UI、网页控制台、购买校验共用的唯一货源，因此**接通服务不需要改控制台前端**：

1. **服务闸门**（58-60 行）：`const serviceOpen = item.id === "cart_restore";` — 除猫车恢复外，`buff_atk/buff_def/buff_crit/gacha_1..4` 全部 `canBuy=false, reason="游戏效果接线完成前暂不开放"`。**解开它们=补效果接线，不是改这个判断**；判断应保留到对应效果落地为止。
2. **临时条件**：`canTrade()` 不满足（不在村庄整备/清波间歇、非单人任务、GUI 弹窗开着）或袋不可读时，全部商品临时 unavailable。这是设计行为。
3. 网页端展示直接消费 `shop.categories[].canBuy/reason`（[webconsole_bridge.ts:252](../src/game/webconsole_bridge.ts)），无第二套判断。

## 2. 翻盘服务逐项接线方案

服务商品定义在 [default_config.ts:545-618](../src/game/default_config.ts)：`cart_restore`（猫车恢复）、`buff_atk/buff_def/buff_crit`（单轮增益）、`gacha_1..4`（装备抽取）。购买路径已统一走 `requestPurchase → tick() → core.buy 扣款 → 效果交付 → 读回验证 → 失败回滚`（shop_window.ts:102-170），**缺的只是"效果交付"这一步**。

### 2.1 猫车恢复：已实现，剩实机验收

- 实现：[native_cart.ts](../src/game/native_cart.ts) — `getDeathNum()` 读 → `setDeathNum(before-1)` 写 → `getDeathNum()` 读回核验；只在整备期调用，不触碰 `setQuestFail/notifyDeath` 失败链。全量方法签名经 sdk-dump 核实（实例方法）。
- 状态快照的 `nativeDeaths`（[webconsole_bridge.ts:248](../src/game/webconsole_bridge.ts)）就是 `readingSnapshot.deaths`，与恢复操作同源，控制台可直接对账 `cartsLeft + nativeDeaths == maxCarts` 是否一致。
- **未实测边界**（文件头已列，验收时重点看）：购买恢复后第三次猫车是否仍按剩余数正确判负；死亡流程进行中购买是否被拒绝（当前只允许 Selecting 期购买，前提满足）；Core 与原生计数在连续猫车后是否漂移。

### 2.2 单轮攻/防/会心（buff_atk/buff_def/buff_crit）

社区先例：[Bimmr Buffer Character.lua](https://github.com/Bimmr/Monster-Hunter-Rise-Reframework-Scripts-/blob/main/Buffer/autorun/Buffer/Modules/Character.lua)（已下载至 `.local/bimmr-study`）：

- 攻/防：`PlayerManager.findMasterPlayer():call("get_PlayerData")` 拿 PlayerData，写 `_AtkUpAlive`（鬼人药 5/大鬼人药 7 档位）、`_DefUpAlive`（硬化药 15/大硬化药 25 档位）。项目已有同款玩家访问链（[native_runtime.ts:130](../src/game/native_runtime.ts) 的 `findMasterPlayer`）。
- 会心：hook `snow.equip.MainWeaponBaseData.get_CriticalRate`，后缀返回值按"目标 − 当前玩家会心 + 武器基础会心"补偿（Character.lua:382-408）。项目 SDK 绑定已导出 `hookMethod/toPtr`（[sdk.ts:158-166](../src/game/sdk.ts)）。
- `snow.equip.MainWeaponBaseData.get_CriticalRate` 在本机 TDB 存在（`snow.data.WeaponData` 同族方法 `get_CriticalRate/adjustCriticalRate/calcCriticalRate` 见 native-equipment.json）；`_AtkUpAlive/_DefUpAlive` 字段名以运行时 `findTypeDefinition("snow.player.PlayerData"):get_field("_AtkUpAlive")` 核对为准（**社区**级证据）。

**接线设计**（遵守总表 §5.3 的约束）：

1. 购买期（Selecting/Prep）：读 `_Attack/_Defence` 基线，写小档位（建议 ±10/±15/±10% 会心内），状态记 `pendingBuff = {atk?, def?, crit?, waveToken}`；同一时间只允许一个未消费 buff（或明确叠加规则）。
2. 生效期：在任务就绪（quest playing）后再写一次——任务初始化/换装/猫车回城会重算玩家数据，**不能只在购买时写一次**；也不做每帧写回（会覆盖药品等正常变化），采用"波开始写、波结束清零"。
3. 消耗与撤销：波次结束或 run 结束时把字段清零、hook 恢复直通；`unresolved` 时按商店事务规则上报，不自动重试。
4. 验收：最终面板攻防与实际伤害/会心跳字对照，不只看"字段写进去了"。

### 2.3 装备抽取（gacha_1..4）

已核实 `snow.data.EquipBox`（native-equipment.json + 运行时 metadata 各 270 方法）：

```text
tryAddGameItem(ContentsIdSystem.WeaponId, EquipmentInventoryData, Boolean)   -- 实测（rogue_test_weapon.lua）
tryAddGameItem(DataDef.PlArmorId, EquipmentInventoryData)                    -- 防具
tryAddGameItem(DataDef.PlTalismanId, EquipmentInventoryData)                 -- 护石
tryAddGameItem(ContentsIdSystem.LvBuffCageId, EquipmentInventoryData)        -- 虫笼
findInventory(WeaponId/PlArmorId/PlTalismanId/LvBuffCageId)                  -- 查已有
getEmptyWeaponArmorInventoryFirst() / countWeaponArmorEmptyNum()             -- 空槽
subEquipment(EquipmentInventoryData)                                         -- 删除条目（实测可用；未穿条目直接删）
saveToBackupInventory() / loadFromBackupInventory()                          -- 全箱备份（慎用，见 §4）
```

**方案**（遵守总表 §4.2"只创建有追踪标识的装备、退出先恢复原装再准确删除"）：

1. **奖池**：配置文件定义每档 gacha 的 `WeaponId/PlArmorId` 列表 + 权重；ID 用社区表（太刀参考 strokkk 表，防具见 §3.1）+ 运行时枚举核验。第一版建议只做**武器+防具**，护石/虫笼后置（珠子、强化语义更复杂）。
2. **发放**（防具实测通过）：village 无任务态；`getEmptyWeaponArmorInventoryFirst()` 取空槽、`_IdType==0` 校验、`tryAddGameItem` 用**显式重载名**写入（§3.2）、读回 `_IdVal/_IdType` + 空槽数减一核验；`findInventory(PlArmorId)` 可直接查已有。
3. **追踪**：RunCore 记录本局生成的条目（槽位序号 + IdVal）；局末恢复玩家原装后逐条 `subEquipment` 删除，删后读回空槽数回升。若中途玩家卖了/分解了该条目，删除失败要记日志而非抛错中断恢复流程。
4. **防重复**：发放前 `findInventory(id)` 查已有即可跳过（如已有同名装备则换一件或改为 PT 补偿）。

## 3. 开局自动穿装（骨套/铁套）——已实测闭环

现状：`armorOptions = ["骨套（均衡）", "铁套（攻高防低）"]` 只是**记录在 `core.state.armor` 的标签**（[run_core.ts:84-96](../src/core/run_core.ts)），没有任何原生穿装动作。

### 3.1 防具 ID——名字读回实测（2026-10-29）

`PlArmorId` 编码：`0x0C <部位 1..5> <系列号>`，部位 1=头 2=身 3=腕 4=腰 5=脚。全量枚举 2570 项已导出至 [plarmorid_runtime_dump.json](evidence/2026-10-29-equip-wiring/plarmorid_runtime_dump.json)（名字是 `A_<部位>_<十进制系列>`，低 24 位即编号）。

**grant→getName→subEquipment 实测结果**（清理干净，装备箱空槽数不变）：

| 系列 | 头部 ID | 读回名字 |
|---|---|---|
| 9 | `0x0C100009` | 合金头盔（Alloy） |
| 10 | `0x0C10000A` | 合金S头盔 |
| 146 | `0x0C100092` | 骨制头盔（Bone） |
| 147 | `0x0C100093` | 骨制S头盔 |
| 144/145 | `0x0C100090/91` | 白兔兽（S）头盔——不是骨套 |

社区 [wiki 表](https://wiki.aoe.top/ModTutorial/MonsterHunterRise/Armor-IDs.html) 与实测一致；`铁套`→合金（系列9），`骨套`→骨制（系列146）。五件即 `0x0C100009 … 0x0C500009` / `0x0C100092 … 0x0C500092`。

### 3.2 补箱重载分发——必须用显式重载名

`EquipBox` 上 `tryAddGameItem` 有 4 个重载（1×三参武器 + 3×两参）。**裸方法名派发选不中防具两参重载**：三参调用会把防具 ID 当 WeaponId 写入但 `_IdType` 保持 0（无效条目），两参裸名调用无效果。唯一可靠写法（已实测）：

```lua
box:call("tryAddGameItem(snow.data.DataDef.PlArmorId, snow.data.EquipmentInventoryData)", id, slot)
-- 读回 _IdType==2 且 _IdVal==id；空槽校验同 rogue_test_weapon 六步协议
```

注意这比项目现有 `item_grant.ts` 的 `ADD_ITEM` 拼写多一个**空格**（"A, B" vs "A,B"）：`snow.data.DataDef.PlArmorId, snow.data.EquipmentInventoryData`（带空格）能命中，`(A,B)` 无空格返回 nil。**两种拼写都要试**，以 `get_method` 命中为准。

### 3.3 穿装机制——`changeEquip` 无效，直接写 pack 数组

实测结论（多次复验）：

- `EquipDataManager.changeEquip(EquipmentInventoryData, PlEquipTypes)` 存在且返回 true，但**不改变任何东西**（pack 数组、`getEquipArmorData` 均无变化）；`EquipBox.changeEquipment` 同样无效。它们大概是换装预览/模型路径，村庄环境下是摆设。
- **权威穿装状态就是 `PlEquipPack._InventoryIndexList : System.Int32[]`**（`get_PlEquipPack` 拿到）。`arr[i] = 装备箱条目索引`，槽位顺序 `[武器, 头, 身, 腕, 腰, 脚, LvBuffCage, 护石]`，-1=空。**sol2 支持直接 `arr[i]=n` 下标写**，写完读回生效——这是唯一实测有效的穿装/卸装方式。
- `equipPlDefaultData()` 会把 pack 清成全 -1（卸全身）——但它是先抛异常再生效（与项目"抛错≠未写入"教训一致），**不要在生产用**，卸装请直接写 -1。
- `reloadPlayerModel(true, nil)` 抛异常（Nullable 参数传法待解）；模型刷新暂缺，**接任务时游戏会用 pack 重建外观**，对肉鸽开局无影响，村庄预览外观可能暂时不更新（无害）。
- `getEquipArmorData/getEquipData` 在村庄返回 nil/空壳，不能用作读回验证；**读回验证 = 重新读 pack 数组元素**。

### 3.4 完整开局流程（probe_equip_set.lua 已验证）

```
1. saveToBackup 前先读 pack 存自有记录 saved[0..7]（这是恢复的真值）
2. 对套装五件：findInventory(PlArmorId) 已有则复用；缺则 tryAddGameItem(显式重载名) 补箱
3. 逐件 findInventory 得到箱内索引，arr[part] = 索引（part=1..5 对应头..脚）
4. 读回 arr 全量，与期望比对
5. 失败任一步：arr[i]=saved[i] 全量回滚，上报 Fault
```

实测记录：合金五件补箱后索引 [29,30,31,32,33]，穿装 [28,29,30,31,32,33,0,-1]，恢复 [28,27,25,22,21,23,0,-1] 全对。**保留在装备箱的 5 件合金是一次实验的副产物**，生产实现要在局末 `subEquipment` 删除本局发放的条目。

## 4. 全身卸装回装备箱——已实测

由于"装备=索引"，卸装=把索引指空：

```lua
local arr = edm:call("get_PlEquipPack"):get_field("_InventoryIndexList")
for i=0,5 do arr[i] = -1 end   -- 武器+五件防具全卸；6/7（虫笼/护石）按需
```

没有"搬运"发生：装备箱条目本来就在箱子里，卸装只是把指向它们的索引清掉。恢复=把保存的旧索引写回（§3.4）。这比原方案的三个候选（changeEquip 空数据/removeEquip/空 MySet）**全部作废**——三者或无效或危险，直写数组是唯一正解。

## 5. 道具袋掏空到道具箱——已实测闭环

原语链（全部实测，`DataManager` 单例上）：

```text
checkSendInventoryStatus(槽位, 65536)   -- 预检，返回值 0 = 可送
getMaxNumberToSend(槽位, 65536)          -- 目标箱还能收多少（实测 9982）
sendInventory(槽位, 65536)              -- 整堆送入（箱内同 ID 栈合并）
revertSendInventory()                    -- 完整回滚上一次搬运
```

实测（回复药 ×10）：袋 10 → send → 袋 0 / 箱 17→27；revert → 袋 10 / 箱 17。全链路读回一致。

道具袋分类实测值（`getInventoryDataList(type)`）：1=NORMAL（普通袋）、2=Temporary（临时袋，任务补给落这里）、3=BulletBottle（弹瓶）、4=Regular（常驻）、5=WireJumpInsect（翔虫）、6=OtDogPouch。空槽哨兵 `ItemId=0x04000000`、`Count=0`。掏空策略按白名单 NORMAL/3 弹瓶即可，2/4/5/6 不动（与 `pouch_backup.ts` 白名单一致）；砥石等 `_Infinite` 物品原生会拒绝或无需处理。

**与 §4.1 备份方案的关系**（不变）：开局清袋走 `beginPouchIsolation`（可恢复、不碰永久箱），局末结算走 sendInventory 入箱（打到的归玩家）。sendInventory 是**不可逆入箱**（revert 只能回滚最近一次），批量掏空要逐槽送、逐槽验证。

## 6. run-script 链路使用规约与楔死风险

`node cli/mhr.mjs game run-script <file> --timeout S --json` 已由上一个 Agent 打通（fork dinput8 `2e7ce5b` 的插件 API + webconsole.dll 0.3.5）：本地文件按内容上传到游戏目录 `reframework/data/webconsole_runs/`，游戏线程执行，`publish_probe` 报告回读；`game last-error` 读框架语法错误。

**探针契约**（照 [probe_equip_set.lua](../reframework/autorun-probe/probe_equip_set.lua)）：整体 pcall；报告 `{kind="run_script", script=<名>, epoch=wc.epoch(), verdict="PASS/FAIL/ERROR", ...}` 经 `require("webconsole").publish_probe(json.dump_string(r))`；只在终态 publish 一次。

**⚠️ 楔死事故记录（2026-10-29）**：一个带语法错误的探针脚本（`get_parameter` 处的 Lua 语法错误）导致**主 Lua 状态整个停摆**——主模块停止 tick（`publishedAt` 冻结 800+ 秒）、`game reset` 无效、任何后续 run-script 全部超时，`/api/script/error` 一直返回该语法错误。恢复手段只有重启游戏进程（taskkill + launch + enter）。**规约**：

1. run-script 前确认主模块活着（`game run-script probe_triv` 或 doctor 心跳新鲜）；
2. 上传前本地用 `luac -p` 或 luacheck 做语法预检（CLI 无校验，语法错误代价是整场游戏重启）；
3. 每个探针整体 pcall + 终态 publish，永不注册不清理的 hook/on_frame；
4. 结构体字段 `set_field(<managed instance>)` 仍是头号红线（HANDOFF-result-screen.md #1），数组元素下标写（`arr[i]=n`）实测安全。

**CLI 归属评估**：run-script 保留为独立 `game` 子命令即可，不建议再往上加封装——它是"游戏内任意 Lua"这一逃生舱口，风险与能力都太大；业务命令（shop/run/wait）继续走 `/api/command`。建议给 CLI 的 run-script 加一步**本地语法预检**（luac -p 可得则跑，失败退出码 2），这属于低成本防楔死保险。

## 7. 建议接线顺序（更新）

1. **P0 已完成**：本轮全部实测（合金/骨制 ID、补箱、穿装、卸装、袋→箱）。
2. **P0 遗留实机验收**：猫车恢复三猫链路（需真猫一次）；`pouch_backup` 接入 run start/stop。
3. **P1 生产化**：把 §3.4/§4/§5 的探针逻辑翻译成 TS 模块（`equip_wear.ts`、`pouch_drain.ts`），接进 `RunSession.start()` 与局末结算；开局穿装必须在接任务前完成（任务装备包在接任务时快照）。
4. **P2**：buff_atk/def/crit（`_AtkUpAlive/_DefUpAlive` 字段已在 PlayerData 上实测可读写，`_Attack/_Defence` 基线、`_CriticalRate` 全局值可读）；gacha 奖池。
5. **P2+**：模型刷新 `reloadPlayerModel` 的 Nullable 参数传法；局末装备清理 `subEquipment` 批量验证。

## 8. 证据索引

- 本轮探针（保留在 reframework/autorun-probe/）：`probe_equip_read.lua`（枚举+盒子+PlayerData）、`probe_bone.lua`（系列名读回）、`probe_equip_set.lua`（穿装闭环）、`probe_send_potion.lua`（袋→箱闭环）
- PlArmorId 全量运行时枚举：[evidence/2026-10-29-equip-wiring/plarmorid_runtime_dump.json](evidence/2026-10-29-equip-wiring/plarmorid_runtime_dump.json)（2570 项）
- 临时探针输出：`.local/probe1..27.json`（历史记录，不入库）
- 既有证据：native-equipment.json、rszmhrise.json、`.local/inplace-live-wait/metadata.json`（见下）
- run-script 链路与契约：[evidence/2026-10-29-script-control/README.md](evidence/2026-10-29-script-control/README.md)、[HANDOFF-result-screen.md](HANDOFF-result-screen.md)（安全红线）
- 社区 ID 表：[小莫维基 Armor IDs](https://wiki.aoe.top/ModTutorial/MonsterHunterRise/Armor-IDs.html)（系列 9=合金、146=骨制与实测一致）
- TDB 全量方法：`docs/evidence/2026-10-27-design-api/native-equipment.json`；RSZ 字段表：`.local/save-editor/assets/mhrise/rszmhrise.json`；ItemBox/ItemPouch 方法：`sdk-dump/sdk_types.json`
- buff 社区先例：`.local/bimmr-study/Buffer/autorun/Buffer/Modules/Character.lua`
- 总表约束（§4.1/§4.2/§5.1/§5.3）：[research-design-native-capabilities.md](research-design-native-capabilities.md)
