/** M3 prototype: single-item purchases, native readback, frame-queued mutations. */
import type { RunCore } from "../core/run_core";
import { replaceOrAdd } from "../core/run_state";
import { canTrade, grantItem, pouchCount, type TradeQuest } from "./item_grant";
import { imguiApi, rejson } from "./sdk";

export class ShopWindow
{
  private category = "";
  private _notice: string | null = null;
  get notice(): string | null { return this._notice; }
  private set notice(v: string | null) { this._notice = v; }
  private pending: string | null = null;
  private unresolved = false;
  private visible = false;
  private wasSelecting = false;

  constructor(private readonly core: RunCore, private readonly selecting: () => boolean,
    private readonly questContext: () => TradeQuest | undefined = () => undefined) {}

  get busy(): boolean { return this.pending !== null || this.unresolved; }

  /** 网页/脚本购买入口：走与点击相同的 pending→tick 执行路径与全部校验。 */
  requestPurchase(id: string): { ok: boolean; message: string }
  {
    if (this.busy) return { ok: false, message: "商店交易进行中" };
    const item = this.core.config.shop.find((entry) => entry.id === id);
    if (!item) return { ok: false, message: "无此商品" };
    if (item.mode !== "perUnit") return { ok: false, message: "补满与服务类暂未开放购买" };
    const pt = this.core.state.wallet.pt;
    if (pt < item.price) return { ok: false, message: `PT不足（需要 ${item.price}，持有 ${pt}）` };
    this.pending = id;
    return { ok: true, message: "queued" };
  }

  open(): void { if (this.selecting()) this.visible = true; }

  tick(): void {
    const id = this.pending;
    this.pending = null;
    if (!id || this.unresolved) return;
    try {
      const context = this.questContext();
      if (!this.selecting() || !canTrade(context)) throw new Error("Shop requires solo preparation or cleared arena between waves");
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
      try { report = grantItem(id, 1, context); }
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
    } catch (error) {
      this.notice = String(error);
      rejson.dump_file("mhw_rogue_shop_transaction.json", { id, blocked: true,
        message: this.notice, pt: this.core.state.wallet.pt }, 2);
    }
  }

  draw(): void {
    // Called from on_frame: independent of Script Generated UI's expansion state.
    if (!this.selecting()) {
      this.visible = false;
      this.wasSelecting = false;
      return;
    }
    if (!this.wasSelecting) { this.visible = true; this.wasSelecting = true; }
    if (!this.visible) return;
    const FIRST_USE_EVER = 4;
    imguiApi.set_next_window_pos([380, 160], FIRST_USE_EVER);
    imguiApi.set_next_window_size([640, 480], FIRST_USE_EVER);
    this.visible = imguiApi.begin_window("肉鸽商店###MhrRogueShop", true, 0);
    try {
    if (!this.visible) return;
    imguiApi.text(`第 ${this.core.state.layer} 层整备 · 余额 ${this.core.state.wallet.pt} PT`);
    imguiApi.text("拖动标题栏移动，拖动边缘缩放；右上角 × 关闭。");
    imguiApi.text("鼠标操作请保持 REFramework 菜单开启，主面板可以收起。");
    imguiApi.separator();

    const shop = this.core.getShop();
    const categories = Object.keys(shop);
    if (!this.category || !categories.includes(this.category)) this.category = categories[0] ?? "";

    // 分类页签
    for (let i = 0; i < categories.length; i++) {
      const c = categories[i]!;
      if (i > 0) imguiApi.same_line();
      if (imguiApi.button(c === this.category ? `[${c}]` : c)) this.category = c;
    }
    imguiApi.separator();
    imguiApi.text("村庄整备或单人斗技场波次间可购买单件；补满和服务暂未开放。");

    const list = shop[this.category] ?? [];
    for (const e of list) {
      let owned: number | null = null;
      try { if (e.mode === "perUnit") owned = pouchCount(e.id); } catch { /* unavailable */ }
      const enabled = !this.busy && this.selecting() && e.mode === "perUnit" && owned !== null &&
        owned < e.cap && this.core.state.wallet.pt >= e.price && e.reason !== "全局限购已达";
      const label = `${e.name}  ${e.price}PT  (${owned ?? "?"}/${e.cap})`;
      if (imguiApi.button(enabled ? label : `${label} [unavailable]`) && enabled) this.pending = e.id;
      imguiApi.same_line();
      imguiApi.text(e.desc ?? e.mode);
    }

    if (this.notice) {
      imguiApi.separator();
      imguiApi.text(this.notice);
    }
    } finally { imguiApi.end_window(); }
  }
}
