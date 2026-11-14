import {beforeEach,expect,it,vi} from "vitest";
import type {EffectOrder} from "../core/effect_orders";
import {validateConfig} from "../core/config";
import {RunCore} from "../core/run_core";
import {defaultConfig} from "./default_config";
import type {RunSession} from "../core/run_session";
import type {GachaService} from "./gacha";
const h=vi.hoisted(()=>({time:1,address:100,atk:0,count:0,dead:false,localDeaths:0,writes:[] as number[],journal:null as any,netJournal:null as any,program:null as any,process:"native-p1"}));
vi.mock("./sdk",()=>({clockSeconds:()=>h.time,loadWebconsole:()=>({epoch:()=>1,steam_digest:()=>"f".repeat(64)}),
 refFs:{read:()=>JSON.stringify({schema:1,modules:["rogue_effects/attack.lua"]})},rejson:{load_string:JSON.parse,dump_string:JSON.stringify},loadEffectChunk:()=>h.program,
 getSingleton:(type:string)=>type==="snow.player.PlayerManager"?{call:()=>({call:(name:string)=>name==="get_PlayerData"?{
   get_address:()=>h.address,get_field:()=>h.atk,set_field:(_f:string,value:number)=>{h.atk=value;h.writes.push(value);}
 }:name==="isDie"?h.dead:name==="getDieCount"?h.localDeaths:3})}:null}));
vi.mock("./recovery_owner",()=>({readRecoveryOwner:()=>({character:"hunter",slot:1,process:h.process,name:"hunter"}),assertRecoveryOwner:()=>({character:"hunter",slot:1,process:h.process,name:"hunter"})}));
vi.mock("./recovery_journal",()=>({readRecoveryRecord:(n:string)=>n==='mhw_rogue_effect_network.json'?h.netJournal:h.journal,
 writeRecoveryRecord:(n:string,value:unknown)=>{if(n==='mhw_rogue_effect_network.json')h.netJournal=structuredClone(value);else h.journal=structuredClone(value);return true;}}));
vi.mock("./item_grant",()=>({grantItem:()=>({granted:false,uncertain:true,before:0,after:10}),pouchCount:()=>h.count,pouchCanReceive:()=>true,canTrade:()=>true}));
import {DesignerEffects} from "./designer_effects";
beforeEach(()=>{Object.assign(h,{time:1,address:100,atk:0,count:0,dead:false,localDeaths:0,writes:[],journal:null,netJournal:null,process:"native-p1"});
 h.program={definition:{id:"attack.flat",version:"1",name:"攻击",description:"字段",delivery:"nextWave",verification:"attribute",experimental:false,rebindOnNativeReset:true,recoveryScope:"runtimeAttribute",group:"attack.flat",quantityParameter:"amount",parameters:{amount:{name:"攻击",description:"固定值",unit:"点",min:1,max:100,default:10,integer:true}}},
  check:(api:any,p:any)=>api.check_stat("_AtkUpAlive",p.amount),apply:(api:any,p:any)=>api.add_stat("_AtkUpAlive",p.amount),
  inspect:(api:any,_p:any,r:any)=>api.inspect_stat(r),remove:(api:any,_p:any,r:any)=>api.restore_stat(r),rebind:(api:any,p:any,r:any)=>api.rebind_stat(r,p.amount)};
});
function fixture(legacyConflict:(group:string)=>string|null=()=>null){
 const cfg=validateConfig(structuredClone(defaultConfig));cfg.effectShop={groups:{[h.program.definition.group]:{cap:30,policy:"add"}},products:[10,20].map(amount=>({id:`attack${amount}`,name:`攻击${amount}`,price:amount*3,enabled:true,effect:{id:h.program.definition.id,version:"1",parameters:{amount}},conditions:{phases:["Selecting"],fromLayer:1,toLayer:99,weapons:[],exclusiveGroups:[]}}))};
 const core=new RunCore(cfg);core.startRun(cfg.armorOptions[0]!);
 const s={core,stage:"Selecting",shopQuest:()=>undefined,startupStatus:{prepared:true,restorePending:true},readingSnapshot:{time:1,quest:{id:900102,unique:77,playing:true},online:false,deaths:0}} as any;
 const service=new DesignerEffects(()=>s as RunSession,()=>cfg,{} as GachaService,legacyConflict);service.initialize();service.tick();
 const snapshot=()=>service.snapshot() as {orders:EffectOrder[];offers:any[];reservedPt:number;availablePt:number;message:string|null};
 const buy=(amount:number)=>{const offer=snapshot().offers.find(e=>e.offer.id===`attack${amount}`).offer;return service.command("buy",{itemId:offer.id,offerVersion:offer.revision,requestId:`buy${amount}`}) as any;};
 const tick=()=>{h.time++;s.readingSnapshot.time=h.time;service.tick();};
 const enter=()=>{h.address=200;h.atk=0;s.stage="Combat";s.readingSnapshot.quest={id:900102,unique:77,playing:true};tick();};
 return {core,s,service,snapshot,buy,tick,enter};
}
it('keeps the existing multiplayer wave path usable when experimental products are configured but unused',()=>{
 const f=fixture();f.s.readingSnapshot.online=true;
 expect(f.service.prepareWave()).toEqual({ok:true});expect(f.service.requiresNativePreparation()).toBe(false);
 expect(f.snapshot().offers[0]!.reason).toContain('仅允许本机单人');
});
it('refuses to carry actual offline commitments into a multiplayer wave without faulting or discarding them',()=>{
 const f=fixture();f.buy(10);f.s.readingSnapshot.online=true;
 expect(f.service.prepareWave()).toMatchObject({ok:false});expect(f.snapshot().orders[0]!.state).toBe('reserved');expect(f.snapshot().reservedPt).toBe(30);expect(f.core.state.wallet.pt).toBe(150);
});
it('blocks the interval after layer advancement until old native effects have actually been removed',()=>{
 const f=fixture();f.buy(10);f.service.prepareWave();f.enter();expect(h.atk).toBe(10);
 f.s.stage='Selecting';f.core.state.layer=2;
 expect(f.service.transactionBusy()).toBe(true);expect(f.service.prepareWave().ok).toBe(false);
 expect(f.snapshot().offers.every(o=>!o.canBuy)).toBe(true);expect(h.atk).toBe(10);
 f.tick();expect(h.atk).toBe(0);expect(f.service.transactionBusy()).toBe(false);expect(f.snapshot().offers[0].canBuy).toBe(true);
});
it('does not certify an unknown inventory delivery from a later coincidental quantity',()=>{
 Object.assign(h.program.definition,{id:'item.grant',group:'item.grant',delivery:'instant',rebindOnNativeReset:false,recoveryScope:'inventory'});
 h.program.check=(api:any)=>api.check_item(6);h.program.apply=(api:any,p:any)=>api.grant_item(6,p.amount);h.program.inspect=(api:any,_p:any,r:any)=>api.inspect_item(r);
 const f=fixture();f.buy(10);expect(f.snapshot().orders[0]!.state).toBe('uncertain');h.count=10;
 f.service.command('inspect',{orderId:f.snapshot().orders[0]!.id,requestId:'inspect'});
 expect(f.snapshot().orders[0]).toMatchObject({state:'uncertain',charged:false});expect(f.core.state.wallet.pt).toBe(150);expect(f.snapshot().reservedPt).toBe(30);
});
it('does not charge an unknown attribute delivery from a replacement actor with the same value',()=>{
 const apply=h.program.apply;h.program.apply=(api:any,p:any)=>({...apply(api,p),status:'unknown'});
 const f=fixture();f.buy(10);f.service.prepareWave();expect(h.atk).toBe(10);h.address=999;
 f.service.command('inspect',{orderId:f.snapshot().orders[0]!.id,requestId:'inspect'});
 expect(f.snapshot().orders[0]).toMatchObject({state:'uncertain',charged:false});expect(f.core.state.wallet.pt).toBe(150);
});
it('retires an unpaid unknown attribute attempt after native restoration to its proven baseline and certified save',()=>{
 const apply=h.program.apply;h.program.apply=(api:any,p:any)=>({...apply(api,p),status:'unknown'});
 const f=fixture();f.buy(10);f.service.prepareWave();expect(h.atk).toBe(10);expect(f.core.state.wallet.pt).toBe(150);
 f.s.stage='Finished';f.tick();h.atk=0;h.localDeaths=1;
 f.service.afterInventoryRecovery('same actor restored to the native attempt baseline and saved');
 expect(f.snapshot().orders[0]).toMatchObject({state:'retired',charged:false});expect(f.snapshot().reservedPt).toBe(0);expect(f.core.state.wallet.pt).toBe(150);
});
it('blocks a conflicting legacy attribute source and releases ownership after cancellation',()=>{
 let old=false;const f=fixture(group=>old&&group==='attack.flat'?'已有原商店强化':null);
 old=true;expect(f.snapshot().offers[0]!.reason).toBe('已有原商店强化');old=false;
 f.buy(10);expect(f.service.runtimeGroupInUse('attack.flat')).toBe(true);
 f.service.command('cancel',{orderId:f.snapshot().orders[0]!.id,requestId:'cancel'});expect(f.service.runtimeGroupInUse('attack.flat')).toBe(false);
});
it('blocks later waves while a paid cleanup is unresolved and keeps a safe cleanup path in preparation',()=>{
 const f=fixture();f.buy(10);f.service.prepareWave();h.program.remove=()=>({status:'unknown',verification:'attribute',message:'清理读回失败'});
 f.s.stage='Carve';f.tick();expect(f.snapshot().orders[0]!.state).toBe('recovery');expect(h.atk).toBe(10);
 f.core.state.layer=2;f.s.stage='Selecting';f.s.canShop=()=>true;
 expect(f.service.prepareWave().ok).toBe(false);expect(f.service.runtimeGroupInUse('attack.flat')).toBe(true);
 expect((f.service.snapshot() as any).blockedReason).toContain('清理读回失败');
 h.program.remove=(api:any,_p:any,r:any)=>api.restore_stat(r);
 f.service.command('cleanup',{orderId:f.snapshot().orders[0]!.id,requestId:'cleanup'});
 expect(h.atk).toBe(0);expect(f.service.blockingReason()).toBeNull();expect(f.service.prepareWave().ok).toBe(true);
});
it('locks first-entry orders without native writes or debit, then applies once in the ready native scene',()=>{
 const f=fixture();f.s.readingSnapshot.quest=null;f.buy(10);expect(f.service.prepareWave().ok).toBe(true);
 expect(h.writes).toEqual([]);expect(f.core.state.wallet.pt).toBe(150);expect(f.snapshot()).toMatchObject({reservedPt:30,availablePt:120});
 expect(f.snapshot().orders[0]!.state).toBe('locked');expect(f.service.requiresNativePreparation()).toBe(true);
 expect(f.service.command('cancel',{orderId:f.snapshot().orders[0]!.id,requestId:'cancel'})).toMatchObject({ok:false});
 f.s.stage='PreparingCombat';expect(f.service.prepareNativeCombat(-42)).toEqual({ok:true});
 expect(h.atk).toBe(10);expect(f.core.state.wallet.pt).toBe(120);expect(f.snapshot().orders[0]!.evidence?.handle?.nativeContext).toContain('|-42|');
 f.s.readingSnapshot.quest={id:900102,unique:-42,playing:true};expect(f.service.prepareNativeCombat(-42)).toEqual({ok:true});expect(h.writes).toEqual([10]);
});
it('cancels a locked but unapplied first-entry promise on stop with no payment',()=>{
 const f=fixture();f.s.readingSnapshot.quest=null;f.buy(10);f.service.prepareWave();f.s.stage='Finished';f.tick();
 expect(f.snapshot().orders[0]).toMatchObject({state:'cancelled',charged:false});expect(f.core.state.wallet.pt).toBe(150);expect(h.writes).toEqual([]);
});
it('prevents eligibility scripts from mutating native state',()=>{
 const f=fixture();h.program.check=(api:any)=>api.add_stat('_AtkUpAlive',10);
 expect(f.snapshot().offers).toEqual([]);expect((f.service.snapshot() as any).invalidProducts[0].reason).toContain('无 add_stat 写入权限');expect(h.writes).toEqual([]);expect(f.core.state.wallet.pt).toBe(150);
});
it('does not let a rebind routine replay a fresh delivery',()=>{
 const f=fixture();f.buy(10);f.service.prepareWave();h.program.rebind=(api:any)=>api.add_stat('_AtkUpAlive',10);f.enter();
 expect(h.atk).toBe(0);expect(f.snapshot().orders[0]!.state).toBe('recovery');expect(f.core.state.wallet.pt).toBe(120);
});
it("rebinds to the new quest actor and after a cart without replaying payment, then verifies cleanup",()=>{
 const f=fixture();expect(f.buy(10).ok).toBe(true);expect(f.service.prepareWave().ok).toBe(true);expect(h.atk).toBe(10);expect(f.core.state.wallet.pt).toBe(120);
 f.enter();expect(h.atk).toBe(10);expect(f.snapshot().orders[0]!.state).toBe("active");expect(f.core.state.wallet.pt).toBe(120);
 const writes=h.writes.length;f.tick();expect(h.writes).toHaveLength(writes);
 h.atk=0;h.localDeaths=1;f.s.readingSnapshot.deaths=1;f.tick();expect(h.atk).toBe(10);expect(f.core.state.wallet.pt).toBe(120);
 f.s.stage="Carve";f.tick();expect(h.atk).toBe(0);expect(f.snapshot().orders[0]!.state).toBe("ended");
});
it("rebinds every contribution in order and removes the stack in reverse order",()=>{
 const f=fixture();f.buy(10);f.buy(20);f.service.prepareWave();expect(h.atk).toBe(30);f.enter();expect(h.atk).toBe(30);expect(f.core.state.wallet.pt).toBe(60);
 f.s.stage="Carve";f.tick();expect(h.atk).toBe(0);expect(f.snapshot().orders.every(o=>o.state==="ended")).toBe(true);
});
it("stops claiming an active effect if another system changed the field without a native context reset",()=>{
 const f=fixture();f.buy(10);f.service.prepareWave();f.enter();h.atk=13;f.tick();
 expect(h.atk).toBe(13);expect(f.snapshot().orders[0]!.state).toBe("recovery");expect(f.snapshot().orders[0]!.charged).toBe(true);
 f.s.stage="Finished";f.tick();expect(h.atk).toBe(13);expect(f.snapshot().orders[0]!.state).toBe("recovery");
});
it("does not guess or overwrite a different baseline in the reconstructed native actor",()=>{
 const f=fixture();f.buy(10);f.service.prepareWave();h.address=200;h.atk=5;f.s.stage="Combat";f.s.readingSnapshot.quest={id:900102,unique:77,playing:true};f.tick();
 expect(h.atk).toBe(5);expect(f.snapshot().orders[0]!.state).toBe("recovery");expect(f.core.state.wallet.pt).toBe(120);
});
it("retires old-process transient obligations after certified inventory recovery without replaying native writes",()=>{
 const f=fixture();f.buy(10);f.service.prepareWave();const receipt=structuredClone(h.journal.orders[0].evidence);
 const writes=h.writes.length;h.process="native-p2";
 const service=new DesignerEffects(()=>f.s,()=>f.core.config,{} as GachaService);
 service.afterInventoryRecovery("exact restored inventory and native save token");
 expect(h.journal.active).toBe(false);expect(h.journal.orders[0]).toMatchObject({state:"retired",charged:true,evidence:receipt,retirement:{proof:"f".repeat(64)}});
 expect(h.writes).toHaveLength(writes);expect(f.core.state.wallet.pt).toBe(120);
});
it("does not use an inventory save to dismiss live-process temporary attributes",()=>{
 const f=fixture();f.buy(10);f.service.prepareWave();const writes=h.writes.length;
 f.service.afterInventoryRecovery("exact restored inventory and native save token");
 expect(h.journal.active).toBe(true);expect(h.journal.orders[0].state).toBe("active");expect(h.atk).toBe(10);expect(h.writes).toHaveLength(writes);
});
it("can certify a paid interrupted stack already cleared to its group baseline after exact inventory restoration and save",()=>{
 const f=fixture();f.buy(10);f.buy(20);f.service.prepareWave();h.atk=0;
 const writes=h.writes.length;const service=new DesignerEffects(()=>f.s,()=>f.core.config,{} as GachaService);
 service.afterInventoryRecovery("certified original inventory and save");
 expect(h.journal.active).toBe(false);expect(h.journal.orders.every((o:EffectOrder)=>o.state==="retired"&&o.charged)).toBe(true);
 expect(h.atk).toBe(0);expect(h.writes).toHaveLength(writes);expect(f.core.state.wallet.pt).toBe(60);
});
it("keeps valid products visible when one implementation is unavailable, and allows it to be taken off sale",()=>{
 const f=fixture();const cfg=structuredClone(f.core.config);cfg.effectShop!.products[0]!.effect.version='missing';f.core.replaceConfig(cfg);
 const snapshot=f.service.snapshot() as any;
 expect(snapshot.offers.map((e:any)=>e.offer.id)).toEqual(['attack20']);
 expect(snapshot.invalidProducts[0].id).toBe('attack10');expect(()=>f.service.validate(cfg)).toThrow('上架商品');
 cfg.effectShop!.products[0]!.enabled=false;expect(()=>f.service.validate(cfg)).not.toThrow();
});
it("waits through both native cart resets and rebinds the full stack only after respawn",()=>{
 const f=fixture();f.buy(10);f.buy(20);f.service.prepareWave();f.enter();expect(h.atk).toBe(30);
 const writes=h.writes.length;h.dead=true;h.localDeaths=1;f.s.readingSnapshot.deaths=1;h.atk=0;f.tick();
 expect(f.snapshot().orders.every(o=>o.state==="suspended")).toBe(true);expect(h.writes).toHaveLength(writes);
 h.atk=0;f.tick();expect(h.writes).toHaveLength(writes);
 h.dead=false;f.tick();expect(h.atk).toBe(30);expect(f.snapshot().orders.every(o=>o.state==="active")).toBe(true);expect(f.core.state.wallet.pt).toBe(60);
 f.s.stage="Carve";f.tick();expect(h.atk).toBe(0);expect(f.snapshot().orders.every(o=>o.state==="ended")).toBe(true);
});
it("does not repeat an intact stack when the same actor returns from a suspended native transition",()=>{
 const f=fixture();f.buy(10);f.buy(20);f.service.prepareWave();f.enter();const writes=h.writes.length;
 h.dead=true;f.tick();h.localDeaths=1;h.dead=false;f.tick();
 expect(h.atk).toBe(30);expect(h.writes).toHaveLength(writes);expect(f.snapshot().orders.every(o=>o.state==="active")).toBe(true);
 f.s.stage="Carve";f.tick();expect(h.atk).toBe(0);
});
it("does not mistake changes to the shared cart balance for a local actor reconstruction",()=>{
 const f=fixture();f.buy(10);f.service.prepareWave();f.enter();const writes=h.writes.length;
 f.s.readingSnapshot.deaths=1;f.tick();f.s.readingSnapshot.deaths=0;f.tick();
 expect(h.atk).toBe(10);expect(h.writes).toHaveLength(writes);expect(f.snapshot().orders[0]!.state).toBe("active");
});
it("can end during a cart after native code cleared the complete stack without recreating intermediate bonuses",()=>{
 const f=fixture();f.buy(10);f.buy(20);f.service.prepareWave();f.enter();
 h.dead=true;h.localDeaths=1;h.atk=0;f.tick();const writes=h.writes.length;
 f.s.stage="Finished";f.tick();expect(h.atk).toBe(0);expect(h.writes).toHaveLength(writes);
 expect(f.snapshot().orders.every(o=>o.state==="ended")).toBe(true);expect(f.core.state.wallet.pt).toBe(60);
});
