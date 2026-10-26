/** M3 prototype: single-item purchases, native readback, frame-queued mutations. */
import type { RunCore } from "../core/run_core";
import { replaceOrAdd } from "../core/run_state";
import { canTradeInVillage, grantItem, pouchCount } from "./item_grant";
import { imguiApi, rejson } from "./sdk";

export class ShopWindow
{
  private category = "";
  private notice: string | null = null;
  private pending: string | null = null;
  private unresolved = false;

  constructor(private readonly core: RunCore, private readonly selecting: () => boolean) {}

  get busy(): boolean { return this.pending !== null || this.unresolved; }

  tick(): void {
    const id = this.pending;
    this.pending = null;
    if (!id || this.unresolved) return;
    try {
      if (!this.selecting() || !canTradeInVillage()) throw new Error("Shop requires idle solo village before wave selection");
      const item = this.core.config.shop.find((entry) => entry.id === id);
      if (!item || item.mode !== "perUnit") throw new Error("Fill/services are awaiting game integration");
      const owned = pouchCount(id);
      this.core.state.wallet = { ...this.core.state.wallet,
        bag: replaceOrAdd(this.core.state.wallet.bag, id, owned) };
      const wallet = this.core.state.wallet;
      const log = this.core.state.log.slice();
      const result = this.core.buy(id);
      if (!result.ok) { this.notice = result.message; return; }
      let report;
      try { report = grantItem(id, 1); }
      catch { report = { granted: false, uncertain: true, gameName: id }; }
      if (report.granted) this.notice = `已购买 ${report.gameName} ×1（${report.before} → ${report.after}）`;
      else if (report.uncertain) {
        this.unresolved = true;
        this.notice = "发货结果不明：PT 已预扣、商店已锁定，请先查交易日志再重试。";
      } else {
        this.core.state.wallet = wallet;
        this.core.state.log = log;
        this.notice = "未发货；PT 与限购记录已恢复。";
      }
      rejson.dump_file("mhw_rogue_shop_transaction.json", { id, report, pt: this.core.state.wallet.pt,
        unresolved: this.unresolved, message: this.notice }, 2);
    } catch (error) { this.notice = String(error); }
  }

  draw(): void {
    if (!imguiApi.tree_node("Shop (M3 prototype)")) return;

    const shop = this.core.getShop();
    const categories = Object.keys(shop);
    if (!this.category || !categories.includes(this.category)) this.category = categories[0] ?? "";

    // 分类页签
    for (const c of categories) {
      imguiApi.same_line();
      if (imguiApi.button(c === this.category ? `[${c}]` : c)) this.category = c;
    }
    imguiApi.separator();
    imguiApi.text("Single items only; fill/services pending integration. Village only.");

    const list = shop[this.category] ?? [];
    for (const e of list) {
      let owned: number | null = null;
      try { if (e.mode === "perUnit") owned = pouchCount(e.id); } catch { /* unavailable */ }
      const enabled = !this.busy && this.selecting() && e.mode === "perUnit" && owned !== null &&
        owned < e.cap && this.core.state.wallet.pt >= e.price && e.reason !== "全局限购已达";
      const label = `${e.name}  ${e.price}PT  (${owned ?? "?"}/${e.cap})`;
      if (imguiApi.button(enabled ? label : `${label} [unavailable]`) && enabled) this.pending = e.id;
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
