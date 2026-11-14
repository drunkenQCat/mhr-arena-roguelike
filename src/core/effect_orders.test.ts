import { expect, it } from "vitest";
import { EffectOrders, type EffectContext, type EffectEvidence, type EffectOrder } from "./effect_orders";
import { copyEffectValue, validateEffectProduct, type EffectOffer } from "./effect_contract";

const context = (player = "host"): EffectContext => ({run:"run-1",wave:"run-1/wave-3",layer:3,player,phase:"Selecting",weapon:3,team:["host","p2"]});
function offer(id = "small", amount = 10, price = 30): EffectOffer {
  return {id,name:id,price,enabled:true,revision:`${id}-v1`,effect:{id:"attack.flat",version:"1",parameters:{amount}},
    definition:{id:"attack.flat",version:"1",name:"攻击加成",description:"攻击加成字段，不等于固定伤害",implementation:"abc123",
      delivery:"nextWave",verification:"attribute",experimental:false,group:"attack.flat",quantityParameter:"amount",
      parameters:{amount:{name:"攻击加成",description:"固定加成",unit:"点",min:1,max:30,default:10,integer:true}}},
    groupRule:{policy:"add",cap:30},conditions:{phases:["Selecting"],fromLayer:1,toLayer:100,weapons:[],exclusiveGroups:[]}};
}
function fixture(restored: EffectOrder[] = [],applyFor?:(id:string)=>EffectEvidence) {
  const balances:Record<string,number>={host:150,p2:150}, charged:string[]=[];
  let calls=0,removed=0,rebound=0,writeFails=false;
  let applied:EffectEvidence={status:"applied",verification:"attribute",before:0,after:10,message:"加成字段 0 → 10"};
  let inspected:EffectEvidence={...applied}, cleanup:EffectEvidence={status:"applied",verification:"attribute",before:10,after:0,message:"加成字段恢复"};
  const writes:EffectOrder[][]=[];
  const engine=new EffectOrders({balance:p=>balances[p]!,
    charge:o=>{if(!charged.includes(o.id)){balances[o.context.player]!-=o.offer.price;charged.push(o.id);}},
    check:()=>null,apply:o=>{calls++;return applyFor?.(o.offer.id)??applied;},inspect:()=>inspected,remove:()=>{removed++;return cleanup;},
    rebind:()=>{rebound++;return applied;},
    fingerprint:JSON.stringify,persist:o=>{if(writeFails)throw Error("disk full");writes.push(copyEffectValue(o));}},restored);
  return {engine,balances,charged,writes,get calls(){return calls;},get removed(){return removed;},get rebound(){return rebound;},
    apply:(r:EffectEvidence)=>{applied=r;},inspect:(r:EffectEvidence)=>{inspected=r;},cleanup:(r:EffectEvidence)=>{cleanup=r;},failWrites:()=>{writeFails=true;}};
}
it("reserves only available PT, freezes the exact promise, and cancels without executing",()=>{
  const f=fixture(),p=offer();const r=f.engine.reserve(p,p.revision,context(),"r1");
  expect(r.ok).toBe(true);expect(f.engine.available("host")).toBe(120);expect(f.balances.host).toBe(150);expect(f.calls).toBe(0);
  p.price=99;p.effect.parameters.amount=20;p.definition.implementation="changed";
  expect(f.engine.snapshot()[0]!.offer.price).toBe(30);expect(f.engine.snapshot()[0]!.offer.effect.parameters.amount).toBe(10);
  expect(f.engine.cancel(r.order!.id,"host").ok).toBe(true);expect(f.engine.available("host")).toBe(150);
});
it("rejects stale displayed terms before accepting an order",()=>{
  const f=fixture(),p=offer();p.revision="new";
  expect(f.engine.reserve(p,"old",context(),"r1").message).toContain("已变化");expect(f.engine.snapshot()).toHaveLength(0);
});
it("applies frozen orders even after the product has been removed or repriced",()=>{
  const f=fixture(),p=offer();f.engine.reserve(p,p.revision,context(),"r1");p.enabled=false;p.price=500;p.effect.parameters.amount=25;
  expect(f.engine.lockWave("run-1",context().wave).ok).toBe(true);expect(f.balances.host).toBe(120);
  expect(f.engine.snapshot()[0]!.offer.effect.parameters.amount).toBe(10);expect(f.engine.snapshot()[0]!.state).toBe("active");
});
it("counts reservations across copied SKUs toward their shared effect group",()=>{
  const f=fixture(),a=offer("a",20),b=offer("copy",20);
  f.engine.reserve(a,a.revision,context(),"r1");expect(f.engine.reserve(b,b.revision,context(),"r2").message).toContain("组上限");
  expect(f.engine.reserved("host")).toBe(30);
});
it("serializes the last team slot, while the buyer pays and benefits",()=>{
  const f=fixture(),p=offer();p.conditions.limit={count:1,scope:"teamRun"};
  const r=f.engine.reserve(p,p.revision,context("p2"),"r1");
  expect(f.engine.reserve(p,p.revision,context(),"r2").message).toContain("全队");
  f.engine.lockWave("run-1",context().wave);expect(f.balances.p2).toBe(120);expect(f.balances.host).toBe(150);
  expect(f.engine.cancel(r.order!.id,"host").ok).toBe(false);
});
it("deduplicates purchases and refuses a reused request with different payload",()=>{
  const f=fixture(),p=offer();f.engine.reserve(p,p.revision,context(),"r1");
  expect(f.engine.reserve(p,p.revision,context(),"r1").duplicate).toBe(true);
  expect(f.engine.reserve(offer("other"),"other-v1",context(),"r1").ok).toBe(false);
  f.engine.lockWave("run-1",context().wave);f.engine.lockWave("run-1",context().wave);expect(f.calls).toBe(1);expect(f.charged).toHaveLength(1);
});
it("locks cancellation atomically before the native application",()=>{
  const f=fixture(),p=offer(),r=f.engine.reserve(p,p.revision,context(),"r1");
  f.engine.lockWave("run-1",context().wave);expect(f.engine.cancel(r.order!.id,"host").ok).toBe(false);
});
it("ends an unused reservation without charging or leaking its quota",()=>{
  const f=fixture(),p=offer();f.engine.reserve(p,p.revision,context(),"r1");f.engine.endRun("run-1");
  expect(f.engine.snapshot()[0]!.state).toBe("cancelled");expect(f.engine.reserved("host")).toBe(0);expect(f.charged).toHaveLength(0);
});
it("does not consume a wave on failed spawn or the death of only the first sequential monster",()=>{
  const f=fixture(),p=offer();f.engine.reserve(p,p.revision,context(),"r1");
  // The logical wave has not ended; neither native quest loads nor individual kills are lifecycle inputs.
  f.engine.lockWave("run-1",context().wave);f.engine.lockWave("run-1",context().wave);
  expect(f.engine.snapshot()[0]!.state).toBe("active");expect(f.removed).toBe(0);
  f.engine.endWave("run-1",context().wave);expect(f.engine.snapshot()[0]!.state).toBe("ended");expect(f.removed).toBe(1);
});
it("refuses to certify a weaker registration check as verified attributes",()=>{
  const f=fixture(),p=offer();f.apply({status:"applied",verification:"registration",message:"登记完成"});
  f.engine.reserve(p,p.revision,context(),"r1");expect(f.engine.lockWave("run-1",context().wave).ok).toBe(false);
  expect(f.engine.snapshot()[0]!.state).toBe("uncertain");expect(f.charged).toHaveLength(0);expect(f.engine.reserved("host")).toBe(30);
});
it("a proven no-delivery releases PT, but holds the wave for the player to review",()=>{
  const f=fixture(),p=offer();f.apply({status:"not-applied",verification:"attribute",message:"目标字段不存在，未写入"});
  f.engine.reserve(p,p.revision,context(),"r1");expect(f.engine.lockWave("run-1",context().wave).ok).toBe(false);
  expect(f.engine.available("host")).toBe(150);expect(f.calls).toBe(1);
  f.engine.reopenWave("run-1",context().wave);expect(f.engine.reserve(p,p.revision,context(),"r2").ok).toBe(true);
});
it("uncertain delivery keeps quota and money reserved, but does not prevent safe end",()=>{
  const f=fixture(),p=offer();p.conditions.limit={count:1,scope:"teamRun"};f.apply({status:"unknown",verification:"registration",message:"读回失败"});
  const r=f.engine.reserve(p,p.revision,context(),"r1");f.engine.lockWave("run-1",context().wave);f.engine.endRun("run-1");
  expect(f.engine.snapshot()[0]!.state).toBe("uncertain");expect(f.engine.reserved("host")).toBe(30);
  f.inspect({status:"applied",verification:"attribute",message:"可靠交付证据"});f.engine.reconcile(r.order!.id);
  expect(f.calls).toBe(1);expect(f.balances.host).toBe(120);f.engine.endRun("run-1");expect(f.engine.snapshot()[0]!.state).toBe("ended");
});
it("cleanup failure remains a recovery obligation instead of saying the effect ended",()=>{
  const f=fixture(),p=offer();f.engine.reserve(p,p.revision,context(),"r1");f.engine.lockWave("run-1",context().wave);
  f.cleanup({status:"unknown",verification:"attribute",message:"仍然读到加成"});f.engine.endWave("run-1",context().wave);
  expect(f.engine.snapshot()[0]!.state).toBe("recovery");expect(f.balances.host).toBe(120);
  f.cleanup({status:"applied",verification:"attribute",message:"原字段已恢复"});f.engine.endRun("run-1");expect(f.engine.snapshot()[0]!.state).toBe("ended");
});
it("immediate deliveries execute and verify before charging and do not wait for combat",()=>{
  const f=fixture(),p=offer();p.definition.delivery="instant";
  const r=f.engine.reserve(p,p.revision,context(),"r1");expect(r.order!.state).toBe("ended");expect(f.calls).toBe(1);expect(f.balances.host).toBe(120);
});
it("does not execute when durable acceptance fails",()=>{
  const f=fixture(),p=offer();f.failWrites();expect(()=>f.engine.reserve(p,p.revision,context(),"r1")).toThrow("disk full");
  expect(f.calls).toBe(0);expect(f.engine.snapshot()).toHaveLength(0);expect(f.engine.available("host")).toBe(150);
});
it("resumes interrupted application as recovery without replaying native writes",()=>{
  const f=fixture(),p=offer();f.engine.reserve(p,p.revision,context(),"r1");
  const records=f.engine.snapshot();records[0]!.state="applying";
  const next=fixture(records);expect(next.engine.snapshot()[0]!.state).toBe("recovery");
  expect(next.engine.lockWave("run-1",context().wave).ok).toBe(false);expect(next.calls).toBe(0);
});
it("validates units, compatibility, useful positive quantities and supported timing",()=>{
  const p=offer();expect(()=>validateEffectProduct(p,p.definition,p.groupRule)).not.toThrow();
  p.effect.parameters.amount=31;expect(()=>validateEffectProduct(p,p.definition,p.groupRule)).toThrow();
  p.effect.parameters.amount=0;expect(()=>validateEffectProduct(p,p.definition,p.groupRule)).toThrow();
  p.effect.parameters.amount=10;p.conditions.phases=["Combat"];expect(()=>validateEffectProduct(p,p.definition,p.groupRule)).toThrow("支持");
});
it("rebinds only opted-in temporary attributes and never charges the buyer twice",()=>{
 const f=fixture(),p=offer();p.definition.rebindOnNativeReset=true;
 const r=f.engine.reserve(p,p.revision,context(),"r1");f.engine.lockWave("run-1",context().wave);
 f.apply({status:"applied",verification:"attribute",before:0,after:10,message:"native actor rebuilt"});
 expect(f.engine.rebind(r.order!.id).ok).toBe(true);expect(f.rebound).toBe(1);expect(f.charged).toHaveLength(1);expect(f.balances.host).toBe(120);
 const instant=offer("item");instant.definition.delivery="instant";const next=f.engine.reserve(instant,instant.revision,{...context("p2"),wave:"run-1/wave-4",layer:4},"r2");
 expect(f.engine.rebind(next.order!.id).ok).toBe(false);expect(f.rebound).toBe(1);
});
it("a failed rebind remains paid recovery, and read-only inspection cannot reactivate or refund it",()=>{
 const f=fixture(),p=offer();p.definition.rebindOnNativeReset=true;const r=f.engine.reserve(p,p.revision,context(),"r1");
 f.engine.lockWave("run-1",context().wave);f.apply({status:"not-applied",verification:"attribute",message:"new base ambiguous"});
 expect(f.engine.rebind(r.order!.id).ok).toBe(false);expect(f.engine.snapshot()[0]).toMatchObject({state:"recovery",charged:true});
 f.inspect({status:"applied",verification:"attribute",message:"attribute still present"});f.engine.reconcile(r.order!.id);
 expect(f.engine.snapshot()[0]!.state).toBe("recovery");expect(f.balances.host).toBe(120);expect(f.charged).toHaveLength(1);
});
it("retires an interrupted order only with recovery proof, preserving evidence and payment history",()=>{
 const f=fixture(),p=offer(),r=f.engine.reserve(p,p.revision,context(),"r1");
 f.engine.lockWave("run-1",context().wave);f.engine.invalidate(r.order!.id,"process interrupted");
 const before=f.engine.snapshot()[0]!;
 expect(()=>f.engine.retireRecovered(before.id,"","native restored")).toThrow();
 expect(f.engine.snapshot()[0]!.state).toBe("recovery");
 f.engine.retireRecovered(before.id,"a".repeat(64),"native restored and saved");
 expect(f.engine.snapshot()[0]).toMatchObject({state:"retired",charged:true,evidence:before.evidence,retirement:{proof:"a".repeat(64)}});
 f.engine.endRun("run-1");expect(f.balances.host).toBe(120);expect(f.charged).toHaveLength(1);expect(f.calls).toBe(1);expect(f.removed).toBe(0);
});
it("allows explicitly supported instant delivery during Carve after wave lock without unlocking delayed effects",()=>{
 const f=fixture();f.engine.lockWave("run-1",context().wave);
 const p=offer("potion");p.definition.delivery="instant";p.definition.supportedPhases=["Selecting","Carve"];p.conditions.phases=["Carve"];
 expect(()=>validateEffectProduct(p,p.definition,p.groupRule)).not.toThrow();
 const r=f.engine.reserve(p,p.revision,{...context(),phase:"Carve"},"carve-potion");
 expect(r.order!.state).toBe("ended");expect(f.balances.host).toBe(120);
 expect(f.engine.reserve(offer(),"small-v1",context(),"late-buff").ok).toBe(false);
});
it("lets the buyer review a proven zero delivery and replace it, without erasing its failure evidence",()=>{
 const f=fixture(),p=offer();f.apply({status:"not-applied",verification:"attribute",message:"no native write"});
 const r=f.engine.reserve(p,p.revision,context(),"r1");f.engine.lockWave("run-1",context().wave);
 expect(f.engine.dismissFailure(r.order!.id,"p2").ok).toBe(false);
 expect(f.engine.dismissFailure(r.order!.id,"host").ok).toBe(true);
 expect(f.engine.snapshot()[0]).toMatchObject({state:"cancelled",charged:false,evidence:{status:"not-applied"}});
 f.apply({status:"applied",verification:"attribute",message:"replacement verified"});
 expect(f.engine.reserve(p,p.revision,context(),"r2").ok).toBe(true);expect(f.engine.lockWave("run-1",context().wave).ok).toBe(true);
 expect(f.balances.host).toBe(120);expect(f.charged).toHaveLength(1);
});
it("does not allow unknown delivery or paid cleanup obligations to masquerade as cancelled failures",()=>{
 const f=fixture(),p=offer();f.apply({status:"unknown",verification:"registration",message:"ambiguous"});
 const r=f.engine.reserve(p,p.revision,context(),"r1");f.engine.lockWave("run-1",context().wave);
 expect(f.engine.dismissFailure(r.order!.id,"host").ok).toBe(false);expect(f.engine.reserved("host")).toBe(30);
 f.inspect({status:"applied",verification:"attribute",message:"delivered"});f.engine.reconcile(r.order!.id);f.engine.invalidate(r.order!.id,"cleanup needed");
 expect(f.engine.dismissFailure(r.order!.id,"host").ok).toBe(false);expect(f.balances.host).toBe(120);
});
it("can continue after abandoning one failed product while preserving another already-paid effect",()=>{
 const f=fixture([],id=>id==="first"?{status:"applied",verification:"attribute",message:"first verified"}:{status:"not-applied",verification:"attribute",message:"second not written"});
 const a=offer("first"),b=offer("second");b.definition.group="defense";
 f.engine.reserve(a,a.revision,context(),"first");const r=f.engine.reserve(b,b.revision,context(),"second");
 expect(f.engine.lockWave("run-1",context().wave).ok).toBe(false);expect(f.balances.host).toBe(120);
 expect(f.engine.dismissFailure(r.order!.id,"host").ok).toBe(true);
 expect(f.engine.lockWave("run-1",context().wave).ok).toBe(true);expect(f.calls).toBe(2);expect(f.balances.host).toBe(120);
 expect(f.engine.check(a,context())).toContain("锁定");
});
it("restores a suspended paid effect as recovery, never as permission to execute or pay again",()=>{
 const f=fixture(),p=offer();p.definition.rebindOnNativeReset=true;
 const r=f.engine.reserve(p,p.revision,context(),"r1");f.engine.lockWave("run-1",context().wave);f.engine.suspend(r.order!.id,"native faint");
 expect(f.engine.snapshot()[0]).toMatchObject({state:"suspended",charged:true});expect(f.engine.cancel(r.order!.id,"host").ok).toBe(false);
 const restored=fixture(f.engine.snapshot());expect(restored.engine.snapshot()[0]!.state).toBe("recovery");
 expect(restored.engine.lockWave("run-1",context().wave).ok).toBe(false);expect(restored.calls).toBe(0);expect(restored.charged).toHaveLength(0);
});
