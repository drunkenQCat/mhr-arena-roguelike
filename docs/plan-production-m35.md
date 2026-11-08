# M3.5 生产化方案：开局装备 / 零物资 / 翻盘服务（对齐策划案 V1.3）

> 历史拆分方案；当前实现与验收以[策划条款对照](design-coverage.md)为准。2026-11-08 起，开局和抽取始终发放独立临时装备，禁止复用同 ID 原有装备，以免带入强化或装饰品；下文原有的“复用”建议已被替代。

日期：2026-10-29。输入：[策划案 V1.3](../../mhw-moddev/docs/ref/design-v1.3.txt)、
[装备与道具袋实测调研](research-shop-unavailable-and-equipment-wiring.md)、现有 M2/M3 代码。
目标：把已实测的原生 API 按策划案条款落成 TS 模块，明确每个模块的接线点、失败矩阵与验收标准。

## 0. 策划案条款 → 现有资产 → 缺口 总览

| 策划案条款 | 现有资产 | 缺口 | 优先级 |
|---|---|---|---|
| §1.2 零开局物资 | `pouch_backup.ts`（备份隔离已写好+测试） | **未接线**（main/session 无调用）；缺跨重载恢复记录 | P1 |
| §1.2 初始二选一 骨套/铁套 | 探针 `probe_equip_set.lua` 闭环 PASS；ID 实测（合金=9/骨制=146） | 无生产模块；`armorOptions` 只是标签 | P1 |
| §1.2 禁用毕业装备/护石 | pack 直写卸装已实测（`arr[i]=-1`） | 同上，并入 equip 模块 | P1 |
| §1.2 150 初始 PT | `core.startRun`（已上线） | 无 | — |
| §1.2 全局砥石无限 | 总表 §5.1 `checkInfiniteFlag`（元数据） | 1 个探针确认 `_Infinite` 生效链 | P3 |
| §3 弹药/素材 fill 补满 | `item_grant.ts` grantFill + config 59 项已对齐价格表 | 缺粉尘外的尾部核对（见 §5 差距表） | P2 |
| §3.6 清除猫车 400PT 限 1 次 | `native_cart.ts` + `core.cartRestore`（已接线） | 实机验收（真猫一次） | P0 验收 |
| §3.6 单轮攻/防/会心 | PlayerData 字段本轮实测可读写；Bimmr hook 先例 | 无效果模块、无波次生命周期 | P2 |
| §3.6 装备抽取 120-700PT | `tryAddGameItem` 显式重载名实测通过；`subEquipment` 清理实测通过 | 奖池配置、追踪、局末清理 | P2 |
| V0.3 极强怪掉落临时装备 | 同 gacha 机制 | 依赖极强怪池（不在本方案） | P3 |
| 结算画面自动化 | `result_accept.lua`（另一 Agent 已实测） | 移植/驱动接入 | P2 |

## 1. 探针 → 生产代码的翻译规约（硬规则，逐条来自实测教训）

1. **显式重载名调用**。`tryAddGameItem` 防具两参重载裸名派发必失败；必须 `get_method("tryAddGameItem(snow.data.DataDef.PlArmorId, snow.data.EquipmentInventoryData)")` 探测命中后按名调用。**同名带空格与不带空格两种拼写都要试**（本轮实测带空格命中、无空格 nil）。
2. **预检 → 单次变更 → 读回 → 交付裁决**。原生调用返回 void 或先抛后写都存在（`equipPlDefaultData` 抛异常但 pack 被清空）；唯一可信的是读回。读回不符且已变更 = `uncertain`，禁止自动重试——沿用 `item_grant.ts` 的 `GrantReport` 语义。
3. **读回验证只用权威源**。穿装的权威源是 `PlEquipPack._InventoryIndexList`，不是 `getEquipData/getEquipArmorData`（村庄返回空壳）也不是 `changeEquip`（返回 true 但无效）。
4. **数组元素下标写安全，结构体字段 `set_field(<managed instance>)` 禁止**（HANDOFF-result-screen 红线 1）。
5. **配置驱动 + 运行时核验 + 核验失败停用**。armor/奖池 ID 进配置，但脚本加载时用 `getName()` 读回一次核对（`findInventory`+临时条目或本地 oracle），对不上即停用该功能并告警，不硬编码上线。
6. **每帧不写回、不悬挂回调**。新模块不得注册不清理的 hook；探针级实验代码不得进生产构建。
7. **所有新写操作落事务日志**（仿 `mhw_rogue_shop_transaction.json`），跨脚本重载可恢复。

## 2. 模块设计

### 2.1 `src/game/equip_wear.ts`（新，P1 核心）

职责：装备箱条目发放、pack 读写、套装穿卸、原装恢复。全部状态来自 `snow.data.EquipDataManager`。

```ts
// 核心导出（签名示意）
export interface PackState { indices: number[] }            // 长度 8：[武器,头,身,腕,腰,脚,虫笼,护石]
export function readPack(edm): PackState | null             // get_PlEquipPack._InventoryIndexList 读 8 项
export function writePackSlot(edm, pos: 0|1|..., boxIndex): { ok, uncertain }
export function findEquipEntry(box, idVal): number | null   // 扫 _WeaponArmorInventoryList 返回箱内索引
export function grantArmor(box, plArmorId): { ok, uncertain, boxIndex }   // 显式重载名 + 空槽校验 + 读回
export function wearSet(edm, box, series: number, slots: 1..5): { ok, granted: number[], prev: PackState }
export function stripArmor(edm): void                        // arr[1..5]=-1（护石/虫笼按参数）
export function restorePack(edm, prev: PackState): void
```

行为细则（全部已实测支撑）：

- 穿装 = `arr[pos] = findEquipEntry(idVal)`；卸装 = `-1`；恢复 = 写回 `prev`。
- 发放前 `findInventory(PlArmorId)` 复用已有条目，避免重复授予。
- **局末清理**：本轮发放的条目（`grantArmor` 返回的 boxIndex + idVal）在恢复 pack **之后**逐条 `subEquipment`；玩家若已卖/分解该条目，删除失败记日志不抛错。判断"是否本局新发"用 `findInventory` 在穿戴前先查一次（查到=旧有，不清理）。
- **模型刷新**：`reloadPlayerModel(true, nil)` 当前抛异常（Nullable 传法未解）。接任务时游戏按 pack 重建外观，故开局穿装不刷新也不影响战斗数值；村庄预览外观可能滞后（已知无害，README 注明）。

### 2.2 配置 schema 扩展（`src/core/config.ts` + `data/rogue_config.json`）

```jsonc
"armorSets": {
  "骨套（均衡）": { "series": 146, "desc": "均衡" },
  "铁套（攻高防低）": { "series": 9,  "desc": "攻高防低" }
},
"startupRules": {
  "stripTalismans": true,     // §1.2 禁用护石
  "stripInsect": false,       // 操虫棍特殊，默认保留
  "keepPlayerWeapon": true    // 见 §6 决策 D1
}
```

- `armorOptions: string[]` 保留（UI 顺序），语义改为"必须是 `armorSets` 的键"；`validateConfig` 增加交叉校验。
- 运行时核验：加载时对每个 series 用名字 oracle（§3.1 调研）核对一次并缓存；失败停用开局穿装并在控制台 reason 中显示。

### 2.3 接线点（RunSession 时序）

`RunSession.start()`（[run_session.ts:145](../src/core/run_session.ts)）现流程：

```
ready/online/canPost 校验 → core.startRun(armor)（扣 PT、置层）→ cancelPost → generate()
```

改为：

```
校验通过后：
  1. equipWear.begin(armor)     // 读 pack 存 prev + 发放套装 + 穿上 + 读回；失败→fault，不接任务
  2. pouch.begin()              // beginPouchIsolation（备份→清 NORMAL/AMMO/BOTTLE）
  3. core.startRun(armor)       // PT 发放
  4. generate()                 // 原流程
```

恢复时机（三处，全走同一 `restoreStartup()`，幂等）：

| 触发 | 位置 | 说明 |
|---|---|---|
| 主动停止 | `stop()` | 立即恢复（此时多半在任务中，pack 写入在任务中是否生效**未实测**，见 §5 风险 R2） |
| 正常结束 | `generate()` 判定层数走完 / `Finished` | 等回到村庄（`reading.quest==null || staleQuest`）再执行恢复 |
| 故障 | `fault()` | 同上，故障恢复路径挂起待回村 |

`RunSession` 本身无 REFramework 全局（测试约束），因此 equipWear/pouch 以**注入的 port 扩展接口**进入：`SessionPort` 增加可选 `startupEquip?: (armor: string) => EquipReport`、`restoreStartup?: () => RestoreReport`，由 `NativeRuntime` 实现，测试用假 port。这与 `takeDeaths/finish` 同构。

### 2.4 跨重载持久化

新文件 `mhw_rogue_startup_state.json`（`rejson.dump_file`）：

```jsonc
{ "active": true, "armor": "骨套（均衡）", "prevPack": [28,27,25,22,21,23,0,-1],
  "granted": [{ "boxIndex": 29, "idVal": 205520905 }], "pouchIsolated": true,
  "ptAtStart": 150, "questId": 900102 }
```

脚本重载后：`main.ts` 启动时读到 `active:true` 即恢复"进行中"语义——**不自动回滚**（可能正在任务里），而是把恢复挂到下一次"回到村庄"事件；`pouchIsolated:true` 时 `endPouchIsolation` 才允许调用（防重复 begin 覆盖备份区，`pouch_backup.ts` 已有该保护）。崩溃后玩家自己的原装备在备份区+该文件里，控制台给出手动恢复按钮（P2，console 已有测试控制区可挂）。

### 2.5 `src/game/buff_service.ts`（新，P2）

策划案：单轮攻/防 80PT、会心 100PT，**仅下一场狩猎生效**。

- 数值进配置（`buffAmounts: { atk: 10, def: 15, crit: 10 }`；默认值取"显著但可用原生药品理解"的档位，待策划定案后改配置即可）。
- 实现：PlayerData（`findMasterPlayer().get_PlayerData()`）`_AtkUpAlive` 写值、`_DefUpAlive` 写值；会心用 `sdk.hook(MainWeaponBaseData.get_CriticalRate)` 后缀补偿（Bimmr 公式），hook 仅在 buff 活跃期间改写、平时直通。
- 生命周期与 shop 事务对齐：
  - 购买（Selecting 期）→ 记 `pendingBuff = { atk?, def?, crit?, questUnique }`，PT 已扣；
  - 任务 playing 后首次 tick **再写一次**字段（任务初始化会重算）；hook 挂上；
  - 任务结束（success/failed/return）→ 字段清零 + hook 直通，事务日志记录；
  - 读回验证：写后读 `_AtkUpAlive` 与期望一致；会心 hook 只能在战斗中验证（记 hook 计数进 runtime 事件流）。
- shop_window：`serviceOpen` 扩为 `["cart_restore","buff_atk","buff_def","buff_crit"]`，新增 `Pending` kind `"buff"`；前端无需改动。

### 2.6 `src/game/gacha.ts`（新，P2）

策划案：初级 120 / 中级 250 / 高级 450 / 顶级 700。

- 配置奖池（`gachaPools: { gacha_1: { weights: [{kind:"weapon", id, w}, {kind:"armor", id, w}] }, ... }`）。第一版池子全部用**实测链路支持的两类**：武器（`rogue_test_weapon.lua` 先例）+ 防具（本轮实测）；护石/虫笼后置。
- 交付：`grantArmor`/武器同款六步协议 → RunCore 记录 `{boxIndex, idVal}` → 控制台/事务日志播报名字（`entry:getName()`）。
- 清理：并入 §2.3 的 `restoreStartup()`（先恢复原装再删本局条目）。
- V0.3 极强怪掉落"古龙临时毕业装备" = 同一 grant+track+cleanup 机制，触发点换成波次结算，不在本方案范围。

### 2.7 结算自动化（P2，先立桩）

`result_accept.lua` 的机制（hook `StmGuiInput` 脉冲 + FSM 节点观察）已被另一 Agent 实测。生产化两步：

1. P2 先以**run-script 步骤**接入会话：session 在 `port.finish()` 后检测 `scene=quest_ready`，由 CLI/控制台触发 `game run-script result_accept.lua`（CLI 侧已可用，零模块改动）。
2. P3 移植为 TS（hooks 进 `native_runtime` 生命周期，随脚本加载安装），供 inPlace 终局自动回村。

## 3. 失败/恢复矩阵

| 失败点 | 后果 | 处理 |
|---|---|---|
| grantArmor 读回不符 | 套装不完整 | 事务标 uncertain，不接任务；控制台显示缺件 |
| pack 写后读回不符 | 穿装未生效 | 同上 |
| pouch begin 失败 | 袋未清空 | **继续开局但标记** `pouchIsolated=false`（设计上零物资是规则而非安全前提）；告警 |
| 任务中 pack 写入 | 未知（R2） | 生产只在村庄写；恢复也等回村 |
| 脚本重载/崩溃 | 内存状态丢失 | §2.4 文件恢复路径；备份区+prevPack 双保险 |
| subEquipment 删除失败 | 箱内残留发件 | 日志 + 控制台提示手动清理；不阻塞恢复 |
| 语法错误 run-script | **主 Lua 楔死** | 不适用于生产 TS（TTLua 编译期保证）；探针工作流规约见调研文档 §6 |

## 4. 实机验收清单（P1 完成定义）

1. 村庄开局选"骨套"：接任务后角色穿骨制五件、袋内仅商店所购、护石卸下；停止运行回村后原装备/原袋恢复，装备箱无新增残留。
2. 同上选"铁套"（合金）。
3. 中途 `game reset`（脚本重载）→ 回村后恢复按钮/自动恢复可用，原装备不丢。
4. 打完最后一层 → 结算 → 回村 → 原装备恢复（依赖 §2.7，先可手动验证 pack 恢复）。
5. 商店买 buff → 下一波面板数值变化 → 波末复原（P2 验收）。
6. 抽取四档各一次 → 箱内出现带名字的新条目 → 局末清理（P2 验收）。
7. 真猫一次 → 猫车恢复 → 第三次猫车规则正确（P0 遗留验收）。

## 5. 对策划案的剩余差距（本方案外，防遗漏）

| 策划案 | 状态 |
|---|---|
| 商店粉尘/秘药/陷阱/种子/闪光 | 配置已有（seed_any 合并三种子、flash 50PT），待核对是否逐一种子单列（策划案是三种各 30PT） |
| 弓麻痹瓶/睡眠瓶/毒瓶 | 配置合并为 bottle_status，同上待定 |
| 难度曲线（血量/伤害倍率） | README 已知问题：乘法 hook 无法纠正错误基础值，总表 §3.1 有调查路线 |
| 极强怪池 / 煌黑黑龙移植 | V0.3，独立方案 |
| 联机 M6 | 独立方案 |
| 结算面板 | console 已有交易/状态面板，V0.3 需求再扩 |

## 6. 决策记录（2026-10-29 用户拍板）

- **D1 武器**：默认保留玩家武器；`startupRules` 保留 `weaponId` 口子（null=不收），日后策划要收武器时填入 ID 即启用，机制无新增（同一条 grant+pack[0] 写法）。
- **D2 buff 数值**：按默认 攻+10 / 防+15 / 会心+10%；**允许叠加购买**（重复购买把加值累加进 pendingBuff，仍受"仅下一场狩猎生效"与波末清零约束）。
- **D3 SKU 拆分**：种子拆为 **怪力种子**（`0x041000DF`=68157919）与 **忍耐种子**（`0x041000E4`=68157924）各 30PT——名称与 ID 均经游戏内 `ItemData:getName()` 实测。策划案的"硬化种子"在 Rise 无对应物品（最接近的硬化粉尘已作为 dust_def 在售），不拆第三个。闪光弹按策划案 ×3/50PT：改为 fill 模式 cap=3。

## 7. M3.5a 实机验收记录（2026-10-29，全部通过）

游戏内完整闭环（CLI 驱动，无手动操作）：

1. `run start --armor "骨套（均衡）"` → pack[1..5] 读回**骨制头盔/铠甲/腕甲/腰甲/护腿**，武器（冥渊斩刀）保留，护石卸下；
2. 袋隔离生效：BulletBottle 清空；**实测发现 `saveToBackupInventory` 本身会把整袋搬进备份区**（连任务补给临时袋 568 件也一并清走），`loadFromBackupInventory` 完整搬回——正好符合策划案"清空全部补给"，且恢复零丢失；
3. pack 写入跨帧存活（120 帧后读回仍是骨制头盔）；
4. `run stop` → 回村自动恢复：原装五件（伞鸟/青熊/搔鸟）全部回来、袋从备份区完整还原、本局发放的骨制五件已从装备箱 `subEquipment` 清理、`mhw_rogue_startup_state.json` 失效。

**验收过程修掉的两个设计缺陷**（都来自第一轮实测失败，正是验收的价值）：

| 缺陷 | 根因 | 修复 |
|---|---|---|
| 开局穿装 1 秒后被撤回 | 恢复检查没有 stage 门：inPlace 首波前 Selecting 本来就在村庄，"回村恢复"立即触发 | 恢复只在 `Idle/Finished/Fault` + 回村时执行（run_session.ts） |
| 袋隔离静默无效 | `pouch_backup.ts` 白名单用了不存在的枚举名（`NORMAL/AMMO/BOTTLE`），clear 全部跳过 | 改为实测枚举名 `Normal`/`BulletBottle`（Temporary/Regular/翔虫/狗袋不动） |

另两条操作教训：**配置变更不会随 build 部署**（README 约定手动复制完整 `rogue_config.json` 到游戏目录，本次开局套装缺失就是配置没同步）；**探针 on_frame 必须 publish 后注销**（frames_wait 探针失控刷屏，冲掉了后续探针报告——规约 §6 已有，执行时也要遵守）。

剩余边界（不阻塞）：玩家原袋为空时 endPouch 的"白名单非空"校验会误报恢复失败（备份区本就是空的）；待改为对比备份区快照计数。

## 8. M3.5b + M3.6 实机验收记录（2026-10-30）

### 猫车恢复（M3.5b，通过）
真猫实测：任务内猫车一次（`nativeDeaths 1`，`cartsLeft 2`）→ 整备期 `cart_restore` 400PT →
回执 `原生死亡计数 1 → 0，剩余猫车 2/3`，状态快照 `nativeDeaths=0`。Core 与原生对齐，事务链完整。

### 单轮增益（M3.6，通过）
村庄买 `buff_atk` 80PT（叠加语义：`addPending` 累加）→ 进任务后探针读 `PlayerData._AtkUpAlive=10` ✓；
猫车后字段归零（玩家对象重建，设计边界：本波失效不重写）✓；任务结束 pending 消耗 ✓。
会心 hook（Bimmr 公式）有单测覆盖；**实机未验收**（本轮只买了攻）——购买会心后 hook 已延迟到
"任务 playing 且有会心 pending"才安装，加载期不挂 hook。

### 装备抽取（M3.6，通过）
`gacha_1` 120PT → 回执 `抽取获得：骨制腰甲`（`EquipmentInventoryData.getName` 实时读回）；
发件 `appendGrantedEntry` 并入局末清理清单，`prevPack` 为空的记录只清发件不动 pack（新增防护+单测）。

### 一次游戏崩溃的定位与修复（2026-10-30）
首局买 buff 后进任务**游戏崩溃**。二分：同套装不带 buff 进任务正常 → 锁定会心 hook
（无条件安装于首次 tick，任务加载期 `get_CriticalRate` 被高频调用）。修复：hook 延迟安装
（购买会心且任务 playing 才装）+ 回调 try/catch（TSTL 编译为 pcall）。修复后一整局 7 层 +
猫车 + 两次结算无再崩。**注意：崩溃根因（hook 在加载线程被调用）是推测，未做 dump 分析。**

### 附带验证：崩溃恢复链
崩溃重启后游戏自动恢复进孤儿任务（900102 playing）：装备箱条目、pack 穿装、袋隔离**全部跨
进程存活**（pack 写入连存档重启都保得住）→ 会话标"恢复待办" → kill-all 触发任务成功 →
`result_accept.lua` 推进结算回村 → 自动恢复原装、发件清理、状态文件失效。零人工干预。

### 空备份误报修复
`endPouchIsolation` 旧校验"恢复后白名单非空"在**原袋为空**（零物资常态）和**备份含临时袋
补给**两种情况下都会误报失败、恢复永久待办。改为：先数备份区总量（空=直接成功），恢复后对
比**全袋总量**（对齐备份语义，2026-10-30 两次实机踩坑后定稿）。

## 9. 里程碑

- **M3.5a（本方案 P1）**：`equip_wear.ts` + config 扩展 + pouch 接线 + 持久化 + 验收 1-3。预估：TS+测试 1 天，实机验收半天。
- **M3.5b（P0 验收）**：猫车恢复真猫验证（半天，可与 a 同场）。
- **M3.6（P2）**：`buff_service.ts` + `gacha.ts` + shop_window 服务放开 + 验收 5-6。
- **M3.7（P2/P3）**：结算自动化（先 run-script 桩，后 TS 移植）+ 验收 4。
