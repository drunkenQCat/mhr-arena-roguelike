# 极强击杀掉落（killWave → gacha_4）验收（2026-10-30）

## 链路

`RunSession.tick` 清波分支（`core.killWave()` 后）：`plan.wave.tier === "ultimate"` 时调用
`port.ultimateDrop()`（NativeRuntime：`GachaService.roll("gacha_4")` → 非复用件
`appendGrantedEntry` 并入局末清理清单）→ `announce("ultimate-drop", …)` 进 runtime 日志。

## 实机记录

1. `run start --test-layer 16` → 选嗟怨怨虎龙（1369）→ Combat；
2. `test kill-all` 清波 → 10s 内 Selecting，PT 150→524（+374），killedUltimates=["嗟怨怨虎龙"]；
3. **掉落**：`runtime_drop_events.json` —
   `{"event":"ultimate-drop","detail":{"name":"骨制S腕甲","ok":true,"reused":false}}`
   （gacha_4 抽中骨制S腕甲 0x0C300093，非复用件，已入清理清单；日志路径符合验收"或日志"）；
4. `run stop` → 失败结算 → result_accept 回村（恢复自动执行）；
5. **清理确认**（`grant_cleanup_probe.json`，verdict=PASS）：
   - 全箱扫描 `_IdVal==204472467 && _IdType==2`：**不存在**（5000 槽全扫）；
   - `mhw_rogue_startup_state.json`: active=false / grantedCount=0；
   - pack 原装恢复（冥渊斩刀+伞鸟/青熊/伞鸟/搔鸟/伞鸟五件）。

## 过程发现

- `EquipBox.findInventory(snow.data.DataDef.PlArmorId)` 对裸数字枚举参数**抛非字符串异常**
  （WeaponId 同形调用正常）——需要时改用 `_WeaponArmorInventoryList` 全扫（本探针即如此）。
- shopNotice 不反映掉落（ShopWindow 只管交易事务）；掉落走 runtime 日志 +
  `ultimate-drop` 事件（`mhw_rogue_runtime.json`）。

## 文件

- `runtime_drop_events.json` — ultimate-drop 事件（骨制S腕甲，reused=false）
- `grant_cleanup_probe.json` — 局末清理探针报告（PASS）
