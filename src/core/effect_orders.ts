import { copyEffectValue, type EffectOffer, type EffectPhase, type Verification } from "./effect_contract";

export type OrderState = "reserved" | "locked" | "applying" | "active" | "suspended" | "cleaning" | "ended" | "cancelled" | "failed" | "uncertain" | "recovery" | "retired";
export interface EffectContext {
  run: string; player: string; wave: string; layer: number; phase: EffectPhase;
  weapon: number; team: string[];
}
export interface EffectEvidence {
  status: "applied" | "not-applied" | "unknown";
  verification: Verification; message: string; before?: number; after?: number;
  /** A serializable receipt; native object addresses are not portable ownership. */
  handle?: Record<string, string | number | boolean>;
}
export interface EffectOrder {
  id: string; requestId: string; context: EffectContext; offer: EffectOffer;
  state: OrderState; charged: boolean; message: string; evidence?: EffectEvidence; cleanup?: EffectEvidence;
  retirement?: {proof:string;reason:string};
}
export interface OrderResult { ok: boolean; message: string; order?: EffectOrder; duplicate?: boolean; uncertain?:boolean }
export interface OrderPort {
  balance(player: string): number;
  /** Idempotent, keyed by order ID; throws before confirming a debit. */
  charge(order: EffectOrder): void;
  check(offer: EffectOffer, context: EffectContext): string | null;
  apply(order: EffectOrder): EffectEvidence;
  inspect(order: EffectOrder): EffectEvidence;
  remove(order: EffectOrder): EffectEvidence;
  rebind?(order: EffectOrder, retainedGroupAfter?:number): EffectEvidence;
  /** Durable write before invoking an effect; throws on failure. */
  persist(orders: EffectOrder[]): void;
  fingerprint(value: unknown): string;
}
const live = (o: EffectOrder) => ["reserved", "locked", "applying", "active", "suspended", "cleaning", "uncertain", "recovery"].includes(o.state);
const verified = (got: Verification, required: Verification) =>
  ["registration", "attribute", "combat"].indexOf(got) >= ["registration", "attribute", "combat"].indexOf(required);

/** One authoritative ledger per run. A native execution is NEVER repeated to resolve ambiguity. */
export class EffectOrders {
  private orders: EffectOrder[] = [];
  private requests: Record<string, { fingerprint: string; order: string }> = {};
  private locked: string[] = [];
  constructor(private readonly port: OrderPort, restored: EffectOrder[] = []) {
    this.orders = copyEffectValue(restored);
    for (const o of this.orders) {
      this.requests[this.key(o.context, o.requestId)] = { fingerprint: this.fingerprint(o.offer, o.context), order: o.id };
      // A process interruption is not evidence that a native operation did not run.
      if (["applying", "active", "suspended", "cleaning"].includes(o.state)) { o.state = "recovery"; o.message = "执行中断，需核对交付与清理；不会自动重放"; }
    }
  }
  snapshot(): EffectOrder[] { return copyEffectValue(this.orders); }
  reserved(player: string): number { return this.orders.filter(o => o.context.player === player && !o.charged && live(o)).reduce((n,o) => n + o.offer.price, 0); }
  available(player: string): number { return this.port.balance(player) - this.reserved(player); }
  private save(): void { this.port.persist(this.snapshot()); }
  private key(c: EffectContext, request: string): string { return `${c.run}|${c.player}|${request}`; }
  private fingerprint(offer: EffectOffer, context: EffectContext): string { return this.port.fingerprint({ offer, context }); }
  private amount(o: EffectOrder): number { return o.offer.definition.quantityParameter ? o.offer.effect.parameters[o.offer.definition.quantityParameter]! : 1; }
  private result(o: EffectOrder, duplicate = false): OrderResult {
    return { ok: !["failed", "cancelled", "uncertain", "recovery"].includes(o.state), message: o.message, order: copyEffectValue(o), duplicate };
  }
  private find(id: string): EffectOrder { const o = this.orders.find(v => v.id === id); if (!o) throw new Error("订单不存在"); return o; }
  private lockedKey(c: EffectContext): string { return `${c.run}|${c.wave}`; }
  check(offer: EffectOffer, c: EffectContext): string | null {
    if (!offer.enabled) return "商品已下架";
    if (!c.run || !c.wave || !c.player || !c.team.includes(c.player)) return "本局、波次或购买者身份无效";
    if (offer.definition.delivery==="nextWave" && this.locked.includes(this.lockedKey(c))) return "本波已锁定，正在应用效果或战斗中";
    if (!offer.conditions.phases.includes(c.phase)) return "当前阶段不可购买";
    if (c.layer < offer.conditions.fromLayer || c.layer > offer.conditions.toLayer) return "当前层数未开放";
    if (offer.conditions.weapons.length > 0 && !offer.conditions.weapons.includes(c.weapon)) return "当前武器类型不符合要求";
    if (this.available(c.player) < offer.price) return `可用 PT 不足（需 ${offer.price}，可用 ${this.available(c.player)}；预留 ${this.reserved(c.player)}）`;
    const same = this.orders.filter(o => o.context.run === c.run && o.context.wave === c.wave && o.context.player === c.player && live(o));
    if (same.some(o => offer.conditions.exclusiveGroups.includes(o.offer.definition.group) || o.offer.conditions.exclusiveGroups.includes(offer.definition.group))) return "与已购买或预订的效果互斥";
    const group = same.filter(o => o.offer.definition.group === offer.definition.group);
    const quantity = offer.definition.quantityParameter ? offer.effect.parameters[offer.definition.quantityParameter]! : 1;
    if (offer.groupRule.policy !== "add" && group.length > 0) return "此效果组已有订单；请先取消旧预订，已生效效果不可替换";
    if (group.reduce((n,o) => n + this.amount(o), 0) + quantity > offer.groupRule.cap) return "已生效与待生效效果合计超过组上限；不截断收费";
    const limit = offer.conditions.limit;
    if (limit) {
      const count = this.orders.filter(o => o.context.run === c.run && o.offer.id === offer.id &&
        !["cancelled", "failed"].includes(o.state) &&
        (limit.scope.startsWith("team") || o.context.player === c.player) &&
        (limit.scope.endsWith("Run") || o.context.wave === c.wave)).length;
      if (count >= limit.count) return `已达${limit.scope.startsWith("team") ? "全队" : "个人"}${limit.scope.endsWith("Run") ? "每局" : "每波"}限购 ${limit.count} 次（含待核实订单）`;
    }
    return this.port.check(offer, c);
  }
  reserve(offer: EffectOffer, displayedRevision: string, c: EffectContext, requestId: string): OrderResult {
    if (!requestId || requestId.length > 160 || requestId.includes("|")) return { ok: false, message: "购买请求标识非法" };
    const key = this.key(c, requestId), old = this.requests[key];
    if (old) {
      if (old.fingerprint !== this.fingerprint(offer,c)) return { ok: false, message: "请求标识已用于其他购买承诺" };
      return this.result(this.find(old.order), true);
    }
    if (displayedRevision !== offer.revision) return { ok: false, message: "商品价格、参数或条件已变化，请查看新内容后重新购买" };
    if (this.orders.length >= 2048) return { ok: false, message: "本局交易记录达到安全上限，请安全结束本局" };
    const unavailable = this.check(offer,c); if (unavailable) return { ok: false, message: unavailable };
    const o: EffectOrder = { id: key, requestId, context: copyEffectValue(c), offer: copyEffectValue(offer), state: "reserved", charged: false,
      message: `已预留 ${offer.price} PT，等待第 ${c.layer} 层完整波次；可取消` };
    this.orders.push(o); this.requests[key] = { fingerprint: this.fingerprint(offer,c), order: o.id };
    try { this.save(); } catch (e) { this.orders.pop(); delete this.requests[key]; throw e; }
    if (offer.definition.delivery === "instant") this.applyOne(o);
    return this.result(o);
  }
  cancel(id: string, player: string): OrderResult {
    const o = this.find(id);
    if (o.context.player !== player) return { ok: false, message: "不能取消其他玩家的订单" };
    if (o.state === "cancelled") return this.result(o,true);
    if (o.state !== "reserved" || this.locked.includes(this.lockedKey(o.context))) return { ok: false, message: "订单已经锁定或应用，不可取消" };
    o.state = "cancelled"; o.message = `预订已取消，释放 ${o.offer.price} PT 和名额`;
    try { this.save(); } catch(e) { o.state = "reserved"; throw e; }
    return { ...this.result(o), ok: true };
  }
  /** User acknowledgement is only valid for proven zero delivery. Unknown
   * delivery and paid cleanup obligations can never use this exit. */
  dismissFailure(id:string,player:string):OrderResult {
    const o=this.find(id);
    if(o.context.player!==player||o.state!=="failed"||o.charged||o.evidence?.status!=="not-applied")
      return {ok:false,message:"仅能放弃已确认未交付、未扣款的失败订单；待核实订单须继续核实"};
    const previous=o.message;o.state="cancelled";o.message="已确认未交付并放弃本次订单；未扣款，原始失败证据保留";
    try{this.save();}catch(e){o.state="failed";o.message=previous;throw e;}
    if(!this.orders.some(v=>v.context.run===o.context.run&&v.context.wave===o.context.wave&&
      ["locked","applying","active","suspended","cleaning","uncertain","recovery"].includes(v.state)))this.reopenWave(o.context.run,o.context.wave);
    return {...this.result(o),ok:true};
  }
  /** A token is the logical run/wave identity, never a map load or a display layer. */
  lockForNative(run:string,wave:string):void {
    const blocked=this.orders.find(o=>o.context.run===run&&o.context.wave===wave&&["failed","uncertain","recovery","applying","cleaning"].includes(o.state));
    if(blocked)throw new Error(blocked.message);
    const key=`${run}|${wave}`;if(!this.locked.includes(key))this.locked.push(key);
    const pending=this.orders.filter(o=>o.context.run===run&&o.context.wave===wave&&o.state==="reserved");
    if(pending.length===0)return;
    for(const o of pending){o.state="locked";o.message="订单已锁定，等待原生角色与场地就绪；仍为预留，尚未扣款";}
    try{this.save();}catch(e){for(const o of pending)o.state="reserved";this.locked=this.locked.filter(v=>v!==key);throw e;}
  }
  lockWave(run: string, wave: string): { ok: boolean; message: string } {
    const key = `${run}|${wave}`;
    if (!this.locked.includes(key)) this.locked.push(key);
    for (const o of this.orders.filter(o => o.context.run === run && o.context.wave === wave && ["reserved","locked"].includes(o.state))) this.applyOne(o);
    const pending = this.orders.find(o => o.context.run === run && o.context.wave === wave && ["applying", "suspended", "failed", "uncertain", "recovery"].includes(o.state));
    return pending ? {ok:false,message:pending.message} : {ok:true,message:"本波效果准备核验完成"};
  }
  /** Allow choices again only when no application could have partially succeeded. */
  reopenWave(run: string, wave: string): void {
    if (this.orders.some(o => o.context.run === run && o.context.wave === wave && ["locked", "applying", "active", "suspended", "cleaning", "uncertain", "recovery"].includes(o.state))) throw new Error("订单已锁定或效果可能已生效，不能解除开战锁定");
    this.locked = this.locked.filter(k => k !== `${run}|${wave}`);
  }
  private applyOne(o: EffectOrder): void {
    o.state = "applying"; o.message = "订单已锁定，正在应用与读回核验"; this.save();
    let evidence: EffectEvidence;
    try { evidence = this.port.apply(copyEffectValue(o)); }
    catch (e) { evidence = { status: "unknown", verification: "registration", message: String(e) }; }
    this.acceptEvidence(o,evidence);
  }
  private acceptEvidence(o: EffectOrder, evidence: EffectEvidence): void {
    o.evidence = copyEffectValue(evidence);
    if (evidence.status === "not-applied") { o.state = "failed"; o.message = `确认未交付：${evidence.message}；已释放预留与名额`; }
    else if (evidence.status === "unknown" || !verified(evidence.verification, o.offer.definition.verification)) {
      o.state = "uncertain"; o.message = `结果待核实：${evidence.message}；保留预留，不自动重试，可安全结束本局`;
    } else {
      // Persist native evidence before confirming money. charge() must be idempotent.
      this.save();
      try { if (!o.charged) { this.port.charge(copyEffectValue(o)); o.charged = true; } }
      catch(e) { o.state = "uncertain"; o.message = `交付已核验，结算待核实：${String(e)}`; this.save(); return; }
      o.state = o.offer.definition.delivery === "instant" ? "ended" : "active";
      o.message = `已${o.state === "active" ? "生效" : "交付"}，扣款 ${o.offer.price} PT；${evidence.message}`;
    }
    this.save();
  }
  reconcile(id: string): OrderResult {
    const o = this.find(id);
    if (!["uncertain", "recovery"].includes(o.state)) return this.result(o,true);
    // inspect is a readback, not a second execution.
    const evidence = this.port.inspect(copyEffectValue(o));
    if(o.charged){
      // A paid cleanup obligation must never become a new delivery, refund, or
      // another active wave merely because someone clicked inspect.
      o.message=`已扣款订单核查：${evidence.message}；请在安全阶段核验清理`;
      this.save();return this.result(o);
    }
    this.acceptEvidence(o,evidence); return this.result(o);
  }
  /** Rebinding is not a purchase or a replay of immediate delivery. The adapter
   * must prove that the native actor/context changed and verify the new write. */
  rebind(id: string, retainedGroupAfter?:number): OrderResult {
    const o=this.find(id);
    if(!["active","suspended"].includes(o.state)||!o.charged||o.offer.definition.delivery!=="nextWave"||
      o.offer.definition.rebindOnNativeReset!==true||!this.port.rebind)
      return {ok:false,message:"此订单不支持原生角色重建后的属性重新绑定"};
    o.state="applying";o.message="原生角色或任务已重建，正在重新绑定本波效果；不重复扣款";this.save();
    let evidence:EffectEvidence;
    try{evidence=this.port.rebind(copyEffectValue(o),retainedGroupAfter);}catch(e){evidence={status:"unknown",verification:"registration",message:String(e)};}
    if(evidence.status==="applied"&&verified(evidence.verification,o.offer.definition.verification)){
      o.evidence=copyEffectValue(evidence);o.state="active";o.message=`本波效果重新核验成功；未重复扣款。${evidence.message}`;
    }else{o.state="recovery";o.message=`本波效果重新绑定待恢复：${evidence.message}；允许安全结束本局`;}
    this.save();return this.result(o);
  }
  invalidate(id:string,message:string):void {
    const o=this.find(id);if(!["active","suspended"].includes(o.state))return;
    o.state="recovery";o.message=`实际效果未能核验：${message}；已停止宣称生效，可安全结束本局`;this.save();
  }
  suspend(id:string,message:string):void {
    const o=this.find(id);if(o.state!=="active"||!o.charged||o.offer.definition.delivery!=="nextWave")return;
    o.state="suspended";o.message=message;this.save();
  }
  cleanupOrder(id:string):OrderResult {
    const o=this.find(id);if(!["active","suspended","cleaning","recovery"].includes(o.state)||!o.charged)return {ok:false,message:"此订单没有可核验的清理任务"};
    this.end(value=>value.id===id);return this.result(o);
  }
  /** Only the native recovery coordinator calls this after its exact inventory
   * snapshot was restored and a fresh matching character save succeeded.
   * Retirement preserves an unknown delivery history; it never manufactures success. */
  retireRecovered(id:string,proof:string,reason:string):void {
    if(proof.length!==64)throw new Error("缺少原生恢复与保存的精确证明摘要");
    const o=this.find(id);if(!live(o))return;
    o.retirement={proof,reason};o.state="retired";o.message=`本局已恢复后封存：${reason}；保留原交付证据，不补扣、不退款、不重放`;this.save();
  }
  endWave(run: string, wave: string): void { this.end(o => o.context.run === run && o.context.wave === wave); }
  endRun(run: string): void { this.end(o => o.context.run === run); }
  private end(matches: (o: EffectOrder) => boolean): void {
    // Undo additive writes in reverse acquisition order, preserving each readback baseline.
    for (const o of this.orders.filter(matches).reverse()) {
      if (["reserved","locked"].includes(o.state)) { o.state = "cancelled"; o.message = "尚未应用，本局或波次已结束；释放预留与名额"; this.save(); }
      else if (["active", "suspended", "cleaning"].includes(o.state) || o.state === "recovery" && o.charged) {
        o.state = "cleaning"; o.message = "清理中，正在核验移除结果"; this.save();
        let result: EffectEvidence;
        try { result = this.port.remove(copyEffectValue(o)); }
        catch(e) { result = {status:"unknown",verification:"registration",message:String(e)}; }
        o.cleanup = copyEffectValue(result);
        o.state = result.status === "applied" && verified(result.verification,o.offer.definition.verification) ? "ended" : "recovery";
        o.message = o.state === "ended" ? `效果已结束；${result.message}` : `清理恢复待办：${result.message}；允许安全结束本局`;
        this.save();
      }
    }
  }
}
