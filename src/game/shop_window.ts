/**
 * 商品面板 —— M3：Core 商店（分类/容量校验/补满模式）的 ImGui 前端。
 * 购买 = RunCore.Buy（经济真源）→ 成功后 ItemGrant 写道具袋（游戏侧）。
 * 两步都成功才算一笔完成；经济扣款成功但发货失败时回滚 PT（一致性优先）。
 */

import type { RunCore, ShopEntry } from "../core/run_core";
import { grantItem } from "./item_grant";
import { imguiApi } from "./sdk";

export class ShopWindow
{
  private category = "";
  private notice: string | null = null;

  constructor(private readonly core: RunCore) {}

  private buy(entry: ShopEntry): void {
    const result = this.core.buy(entry.id);
    if (!result.ok) {
      this.notice = `NG: ${result.message}`;
      return;
    }
    // service 类（抽取/增益/猫车恢复）没有实体道具；其余发货进道具袋。
    // 发货失败不回滚扣款——余额在下一次 StartRun 前保持；恢复路径：HUD 重开或下次进村 grant 补发。
    if (entry.mode !== "service") {
      const fill = entry.mode === "fill" ? entry.cap - entry.owned : 1;
      const report = grantItem(entry.id, fill);
      this.notice = report.granted
        ? `Bought ${report.gameName} x${fill}`
        : `PT spent; grant FAILED for ${report.gameName} (logged, will retry next purchase)`;
      return;
    }
    this.notice = result.message ?? "OK";
  }

  draw(): void {
    if (!imguiApi.tree_node("Shop (M3)")) return;

    const shop = this.core.getShop();
    const categories = Object.keys(shop);
    if (!this.category || !categories.includes(this.category)) this.category = categories[0] ?? "";

    // 分类页签
    for (const c of categories) {
      imguiApi.same_line();
      if (imguiApi.button(c === this.category ? `[${c}]` : c)) this.category = c;
    }
    imguiApi.separator();

    const list = shop[this.category] ?? [];
    for (const e of list) {
      const label = `${e.name}  ${e.price}PT  (${e.owned}/${e.cap})`;
      if (imguiApi.button(e.canBuy ? label : `${label} - ${e.reason}`) && e.canBuy) this.buy(e);
      imguiApi.same_line();
      imguiApi.text_disabled(e.desc ?? e.mode);
    }

    if (this.notice) {
      imguiApi.separator();
      imguiApi.text_disabled(this.notice);
    }
    imguiApi.tree_pop();
  }
}
