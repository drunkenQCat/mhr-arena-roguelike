/** M3 商店窗口：单件 + 补满 + 猫车恢复；读回验证、事务日志、失败恢复。 */
import type { RunCore, ShopEntry, PurchaseCheckpoint } from "../core/run_core";
import { replaceOrAdd } from "../core/run_state";
import { readLobbyIdentity } from "./multiplayer_entry";
import { canTrade, grantFill, grantItem, pouchCount, pouchCanReceive, type TradeQuest } from "./item_grant";
import { restoreNativeCart } from "./native_cart";
import type { GachaRollResult } from "./gacha";
import type { BuffKind } from "./buff_service";
import { clockSeconds, imguiApi, rejson } from "./sdk";

type Pending =
  | { kind: "item"; id: string }
  | { kind: "fill"; id: string }
  | { kind: "cartRestore" }
  | { kind: "buff"; id: string }
  | { kind: "gacha"; id: string };

/** 翻盘服务效果交付（main.ts 注入；缺省=仅猫车恢复可用）。 */
export interface ServiceEffects {
  buffBuy(kind: BuffKind): { ok: boolean; total: number };
  gachaBuy(poolId: string): GachaRollResult;
  hasGachaPool(poolId: string): boolean;
}

export class ShopWindow
{
  private category = "";
  private _notice: string | null = null;
  get notice(): string | null { return this._notice; }
  private set notice(v: string | null) { this._notice = v; }
  private pending: Pending | null = null;
  private unresolved = false;
  private visible = false;
  private wasSelecting = false;
  private catalogueAt = -1;
  private catalogueKey = "";
  private catalogueConfig: RunCore["config"] | null = null;
  private cachedCatalogue: { available: boolean; reason: string | null; categories: Record<string, ShopEntry[]> } | null = null;
  transactionVersion = 0;
  lastTransaction: { status: string; message: string } | null = null;

  private complete(status: string, message: string): void {
    this.transactionVersion++;
    this.lastTransaction = { status, message };
  }

  constructor(private readonly core: RunCore, private readonly selecting: () => boolean,
    private readonly questContext: () => TradeQuest | undefined = () => undefined,
    private readonly services: ServiceEffects | null = null) {}

  get busy(): boolean { return this.pending !== null || this.unresolved; }

  /** One source of truth for native UI, web UI and purchase validation. No phase cache. */
  catalogue(fresh = false): { available: boolean; reason: string | null; categories: Record<string, ShopEntry[]> } {
    const now = clockSeconds(), selecting = this.selecting();
    const key = `${this.core.state.phase}:${this.core.state.layer}:${this.core.state.wallet.pt}:${this.busy}:${selecting}:${this.core.state.cartsLeft}`;
    if (!fresh && this.cachedCatalogue && this.catalogueAt === now && this.catalogueKey === key && this.catalogueConfig === this.core.config)
      return this.cachedCatalogue;
    const available = selecting && !this.busy && canTrade(this.questContext());
    const reason = this.busy ? "交易处理中或结果待核实" : !this.selecting()
      ? "清波后返回集结点，等待进入整备阶段" : !available ? "等待任务身份和原生发货条件就绪" : null;
    const unreadable: string[] = [];
    for (const item of this.core.config.shop) if (item.mode !== "service") {
      try {
        const owned = pouchCount(item.id);
        this.core.state.wallet.bag = replaceOrAdd(this.core.state.wallet.bag, item.id, owned);
      } catch { unreadable.push(item.id); }
    }
    const categories = this.core.getShop();
    for (const category of Object.keys(categories)) for (const item of categories[category]!) {
      // service 开放范围：猫车恢复（已接线）、单轮增益（buff 服务）、抽取（有奖池配置才开）
      if (item.id === "cart_restore" && this.questContext()?.multiplayer && readLobbyIdentity().role !== "host") {
        item.canBuy = false; item.reason = "共享猫车次数由房主购买恢复"; continue;
      }
      const serviceOpen = item.id === "cart_restore" || item.id.startsWith("buff_") ||
        (item.id.startsWith("gacha_") && this.services !== null && this.services.hasGachaPool(item.id));
      if (item.mode === "service" && !serviceOpen) { item.canBuy = false; item.reason = "游戏效果接线完成前暂不开放"; continue; }
      if (unreadable.includes(item.id)) { item.canBuy = false; item.reason = "道具映射或背包尚未就绪"; }
      if (available && item.canBuy && item.mode !== "service" && !pouchCanReceive(item.id)) {
        item.canBuy = false; item.reason = "原生背包当前不接受此物品：可能已满、不可携带或格位不足";
      }
      if (!available) { item.canBuy = false; item.reason = reason; }
    }
    this.catalogueAt = now; this.catalogueKey = key; this.catalogueConfig = this.core.config;
    this.cachedCatalogue = { available, reason, categories };
    return this.cachedCatalogue;
  }

  /** 网页/脚本购买入口：走与点击相同的 pending→tick 执行路径与全部校验。 */
  requestPurchase(id: string): { ok: boolean; message: string }
  {
    if (this.busy) return { ok: false, message: "商店交易进行中" };
    const listing = this.catalogue(true);
    const entry = Object.keys(listing.categories).map((key) => listing.categories[key]!)
      .reduce((all, items) => all.concat(items), [] as ShopEntry[]).find((item) => item.id === id);
    if (!entry?.canBuy) return { ok: false, message: entry?.reason ?? listing.reason ?? "无此商品" };
    const item = this.core.config.shop.find((entry) => entry.id === id);
    if (!item) return { ok: false, message: "无此商品" };
    const pt = this.core.state.wallet.pt;
    if (pt < item.price) return { ok: false, message: `PT不足（需要 ${item.price}，持有 ${pt}）` };
    if (item.mode === "fill") this.pending = { kind: "fill", id };
    else if (item.id === "cart_restore") this.pending = { kind: "cartRestore" };
    else if (item.id.startsWith("buff_")) this.pending = { kind: "buff", id };
    else if (item.id.startsWith("gacha_")) this.pending = { kind: "gacha", id };
    else this.pending = { kind: "item", id };
    return { ok: true, message: "queued" };
  }

  open(): void { if (this.selecting()) this.visible = true; }

  private settle(ok: boolean, notice: string, snapshot?: PurchaseCheckpoint): void {
    if (!ok && snapshot) {
      // 未发货：恢复扣款与限购记录（Core.buy 已做的变更全部回滚）
      this.core.rollbackPurchase(snapshot);
    }
    this.notice = notice;
    this.complete(this.unresolved ? "uncertain" : ok ? "applied" : "rejected", notice);
    try { rejson.dump_file("mhw_rogue_shop_transaction.json",
      { notice, pt: this.core.state.wallet.pt, unresolved: this.unresolved }, 2); } catch { /* Diagnostic only. */ }
  }

  tick(): void {
    const req = this.pending;
    this.pending = null;
    if (req) this.catalogueAt = -1;
    if (!req || this.unresolved) return;
    let debited = false;
    try {
      const context = this.questContext();
      if (req.kind === "cartRestore" && context?.multiplayer && readLobbyIdentity().role !== "host") throw new Error("共享猫车恢复仅允许房主购买");
      if (!this.selecting() || !canTrade(context)) throw new Error("需要在村庄整备或清波后的斗技场波次间购买");
      const item = this.core.config.shop.find((entry) => entry.id ===
        (req.kind === "cartRestore" ? "cart_restore" : req.id));
      if (!item) throw new Error("无此商品");
      if (req.kind !== "cartRestore" && req.kind !== "buff" && req.kind !== "gacha") {
        const owned = pouchCount(req.id);
        this.core.state.wallet = { ...this.core.state.wallet,
          bag: replaceOrAdd(this.core.state.wallet.bag, req.id, owned) };
      }
      // 快照用于"未发货即回滚扣款与限购"
      const snapshot = this.core.purchaseCheckpoint();
      const result = this.core.buy(item.id);
      if (!result.ok) { this.notice = result.message; this.complete("rejected", result.message ?? "购买未完成"); return; }
      debited = true;

      if (req.kind === "item") {
        const report = grantItem(req.id, 1, context);
        if (report.granted) {
          this.settle(true, `已购买 ${report.gameName} ×1（${report.before} → ${report.after}）`);
        } else if (report.uncertain) {
          this.unresolved = true;
          this.settle(false, "发货结果不明：PT 已预扣、商店已锁定，请先查交易日志再重试。");
        } else {
          this.settle(false, `未发货（${report.reason ?? "原因未知"}）；PT 与限购记录已恢复。`, snapshot);
        }
        return;
      }

      if (req.kind === "fill") {
        const report = grantFill(req.id, item.cap, context);
        if (report.granted) {
          this.settle(true, `已补满 ${report.gameName}（${report.before} → ${report.after}，补 ${report.gap}）`);
        } else if (report.full) {
          this.settle(false, `${report.gameName} 已是满的；PT 未扣（Core 记录已回滚）。`, snapshot);
        } else if (report.uncertain) {
          this.unresolved = true;
          this.settle(false, "补满结果不明：PT 已预扣、商店已锁定，请先查交易日志再重试。");
        } else {
          this.settle(false, `补满未完成（${report.reason ?? "原因未知"}）；PT 与限购记录已恢复。`, snapshot);
        }
        return;
      }

      if (req.kind === "buff") {
        const kind = req.id as BuffKind;
        if (!this.services) { this.settle(false, "服务未装配；PT 与限购记录已恢复。", snapshot); return; }
        const applied = this.services.buffBuy(kind);
        if (applied.ok) this.settle(true, `增益已累计（当前总加值 ${applied.total}），下一场狩猎生效`);
        else this.settle(false, "增益登记失败；PT 与限购记录已恢复。", snapshot);
        return;
      }

      if (req.kind === "gacha") {
        if (!this.services) { this.settle(false, "服务未装配；PT 与限购记录已恢复。", snapshot); return; }
        const rolled = this.services.gachaBuy(req.id);
        if (rolled.ok) {
          this.settle(true, `抽取获得：${rolled.name ?? rolled.id}${rolled.name ? "" : "（名字读回失败，以装备箱为准）"}`);
        } else if (rolled.uncertain) {
          this.unresolved = true;
          this.settle(false, `抽取结果不明（${rolled.reason ?? "未知"}）：PT 已预扣、商店已锁定，请查装备箱与交易日志。`);
        } else {
          this.settle(false, `抽取未完成（${rolled.reason ?? "未知"}）；PT 与限购记录已恢复。`, snapshot);
        }
        return;
      }

      // cartRestore：Core 记账 + 原生计数对齐（design doc §5.2）
      const native = restoreNativeCart();
      if (native.ok) {
        this.settle(true, `猫车恢复完成：原生死亡计数 ${native.before} → ${native.after}，剩余猫车 ${this.core.state.cartsLeft}/${this.core.config.maxCarts}`);
      } else if (native.uncertain) {
        this.unresolved = true;
        this.settle(false, "猫车恢复结果不明：PT 已预扣、商店已锁定，请核实原生死亡计数后处理。");
      } else {
        this.settle(false, `猫车恢复未完成（${native.reason ?? "原因未知"}）；PT 与限购记录已恢复。`, snapshot);
      }
    } catch (error) {
      // Once debited, an unexpected wrapper failure cannot prove the native mutation absent.
      if (debited) this.unresolved = true;
      this.notice = debited ? `交付结果待核实，禁止自动重试：${String(error)}` : String(error);
      this.complete(debited ? "uncertain" : "rejected", this.notice);
      try { rejson.dump_file("mhw_rogue_shop_transaction.json", { blocked: true,
        message: this.notice, pt: this.core.state.wallet.pt }, 2); } catch { /* Diagnostic only. */ }
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

      const shop = this.catalogue().categories;
    const categories = Object.keys(shop);
    if (!this.category || !categories.includes(this.category)) this.category = categories[0] ?? "";

    // 分类页签
    for (let i = 0; i < categories.length; i++) {
      const c = categories[i]!;
      if (i > 0) imguiApi.same_line();
      if (imguiApi.button(c === this.category ? `[${c}]` : c)) this.category = c;
    }
    imguiApi.separator();
    imguiApi.text("单件直接购买；弹药/素材为补满（一次补到携带上限）；猫车恢复对齐原生计数。");

    const list = shop[this.category] ?? [];
    for (const e of list) {
      const owned: number | null = e.mode === "service" ? null : e.owned;
      const enabled = e.canBuy;
      const label = e.mode === "service"
        ? `${e.name}  ${e.price}PT`
        : `${e.name}  ${e.price}PT  (${owned ?? "?"}/${e.cap}${e.mode === "fill" ? " 补满" : ""})`;
      if (imguiApi.button(enabled ? label : `${label} [unavailable]`) && enabled) this.requestPurchase(e.id);
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
