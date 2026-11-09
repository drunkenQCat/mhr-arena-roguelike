import { createHash } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
import { MultiplayerRun, canonical } from "./multiplayer_run";
import { RunCore } from "../core/run_core";
import { RunSession, type RuntimeReading, type SessionPort } from "../core/run_session";
import { makeQuestPlan } from "../core/quest_plan";
import { validateConfig } from "../core/config";
import { defaultConfig, monsterCatalog } from "./default_config";
import type { NativeRuntime } from "./native_runtime";
import type { NativeWebconsole } from "./sdk";
import {ConfigStore,CONFIG_FILE} from "./config_store";
const mock = vi.hoisted(() => ({ now:100, valid:true }));
vi.mock("./multiplayer_scope", () => ({ multiplayerScope: () => mock.valid }));
vi.mock("./sdk", () => ({ clockSeconds:()=>mock.now, rejson:{ dump_string:JSON.stringify, load_string:JSON.parse } }));
vi.mock("./equipment_catalog",()=>({validateEquipmentConfig:()=>{}}));
function fixture(size=2,configUpdates=false) {
  const bus = { plan:"", members:["h","g","g2","g3"].slice(0,size), owner:"h", acks:{} as Record<string,string>,
    configControl:"",configPayload:"",complete:true,configAcks:{} as Record<string,string> };
  const make = (self:string) => {
    const cfg=validateConfig(defaultConfig); cfg.quest={...cfg.quest,id:900103};
    cfg.runtime={...cfg.runtime!,carveSeconds:1,campDwellSeconds:0,pollSeconds:1};
    const core=new RunCore(cfg,42);
    let run:MultiplayerRun;
    const reading:RuntimeReading={time:mock.now,quest:{id:900103,unique:7,playing:true,status:"play"},
      online:true,canPost:false,deaths:0,players:[{id:0,position:{x:10,y:20,z:30}},{id:1,position:{x:10,y:20,z:30}}],enemies:[]};
    const publish=vi.fn(), policy=vi.fn(), finish=vi.fn(), guardFailure=vi.fn(),ultimateDrop=vi.fn(()=>({ok:true}));
    const port:SessionPort={now:()=>mock.now,ready:()=>true,read:()=>({...reading,time:mock.now}),publish,policy,
      post:vi.fn(),cancelPost:vi.fn(),postingError:()=>null,takeDeaths:()=>[],finish,guardFailure,ultimateDrop,report:vi.fn(),
      multiplayerRole:()=>run?.role ?? null, multiplayerValid:()=>run?.valid() ?? false, multiplayerCanChoose:()=>run?.canChoose() ?? false};
    port.partySize=()=>run?.partySize() ?? null;
    let userConfig={...cfg,quest:{...cfg.quest,id:900102}};
    const session=new RunSession(core,monsterCatalog,port,next=>{userConfig={...next,quest:{...next.quest,id:900102}};});
    port.multiplayerConfigBusy=()=>run?.configBusy()??false;
    const files:Record<string,string>={[CONFIG_FILE]:JSON.stringify(userConfig)};
    const diskState={fail:""};
    const store=new ConfigStore({read:name=>files[name]??null,
      write:(name,text)=>{if(name===diskState.fail)return false;files[name]=text;return true;},
      digest:text=>createHash("sha256").update(text).digest("hex")});
    const network:NativeWebconsole={ping:s=>s,epoch:()=>1,take_commands:()=>[],publish_state:()=>{},publish_results:()=>{},
      steam_digest:s=>createHash("sha256").update(s).digest("hex"),
      steam_snapshot:()=>({available:true,reason:"",lobbies:[{id:"l",owner:bus.owner,self,plan:bus.plan,
        config:{control:bus.configControl,payload:bus.configPayload,complete:bus.complete,digest:createHash("sha256").update(bus.configPayload).digest("hex")},
        members:bus.members.map(id=>({id,ack:bus.acks[id]??"",configAck:bus.configAcks[id]??""}))}]}),
      steam_config_payload:(_l,text)=>{bus.configPayload=text;return self==="h";},
      steam_config_control:(_l,text)=>{bus.configControl=text;return self==="h";},
      steam_config_ack:(_l,text)=>{bus.configAcks[self]=text;return true;},
      steam_plan:(_l,text)=>{expect(Buffer.byteLength(text)).toBeLessThanOrEqual(2048);bus.plan=text;return self==="h";},
      steam_ack:(_l,text)=>{bus.acks[self]=text;return true;}};
    const mirrorCartRestore=vi.fn(); const runtime={publish,report:vi.fn(),mirrorCartRestore} as unknown as NativeRuntime;
    let busy=false;
    run=new MultiplayerRun({lobby:"l",owner:"h",self,session:"s",members:[...bus.members]},cfg,monsterCatalog,session,runtime,()=>busy,network,
      configUpdates?{userConfig:()=>userConfig,store}:undefined);
    const wave={index:0,mode:"single" as const,typeTag:"A",label:"entry",monsters:["Great Izuchi"],tier:"weak",hpMul:1,dmgMul:1,rewardMul:0,rewardPt:0};
    expect(session.adoptMultiplayerEntry(makeQuestPlan(cfg,monsterCatalog,wave,1,1,false)).ok).toBe(true);
    session.tick();
    return {run,session,core,cfg,reading,publish,policy,finish,guardFailure,ultimateDrop,network,mirrorCartRestore,setBusy:(v:boolean)=>busy=v,
      userConfig:()=>userConfig,files,diskState};
  };
  const host=make("h"),guests=bus.members.slice(1).map(make),guest=guests[0]!;
  const tick=()=>{mock.now++;host.session.tick();host.run.tick();for(const peer of guests){peer.session.tick();peer.run.tick();}};
  const clear=()=>{host.reading.enemies=host.session.plan!.monsterIds.map((typeId,i)=>({uid:100+host.core.state.layer*10+i,typeId,dead:true,captured:false}));tick();tick();tick();};
  return {host,guest,guests,bus,tick,clear};
}
beforeEach(()=>{mock.now=100;mock.valid=true;});
it("transports stop intent without inventing the guest's native result",()=>{
 const f=fixture();f.tick();f.host.session.stop();f.tick();
 expect(JSON.parse(f.bus.plan).endIntent).toBe("stopped");
 expect(f.guest.session.runSummary().ending).toEqual({intent:"stopped",native:null});
 expect(f.guest.finish).not.toHaveBeenCalled();
 f.guest.reading.quest!.status="failed";f.guest.reading.quest!.playing=false;f.guest.reading.deaths=0;f.tick();
 expect(f.guest.session.runSummary().ending.native).toMatchObject({status:"failed",unique:7,deaths:0});
 expect(f.guest.finish).not.toHaveBeenCalled();
});
it("rejects a nonterminal frame carrying a terminal intent",()=>{
 const f=fixture();f.tick();const frame=JSON.parse(f.bus.plan);frame.n+=100;frame.endIntent="cleared-all";
 f.bus.plan=JSON.stringify(frame);mock.now++;f.guest.run.tick();
 expect(f.guest.session.stage).toBe("Fault");
 expect(f.guest.session.runSummary().ending.native).toBeNull();
});
it.each([2,3,4])("reconciles a late host ending after native failure without replaying gameplay across %i peers",size=>{
 const f=fixture(size);f.tick();
 for(const p of f.guests){p.reading.quest!.status="failed";p.reading.quest!.playing=false;}
 f.tick();
 for(const p of f.guests){
   expect(p.session.endingIntent).toBe("native-ended");
   expect(p.run.snapshot().live).toBe(false);
 }
 f.host.session.stop();mock.now++;f.host.run.tick();
 const end=JSON.parse(f.bus.plan);end.earned=999;end.cartUsed=true;f.bus.plan=JSON.stringify(end);
 for(const p of f.guests){
   const before=p.session.runSummary(),published=p.publish.mock.calls.length,guards=p.guardFailure.mock.calls.length;
   p.setBusy(true);p.run.tick();
   expect(p.session.runSummary()).toEqual({...before,ending:{...before.ending,intent:"stopped"}});
   expect(p.publish).toHaveBeenCalledTimes(published);expect(p.guardFailure).toHaveBeenCalledTimes(guards);
   expect(p.mirrorCartRestore).not.toHaveBeenCalled();expect(p.ultimateDrop).not.toHaveBeenCalled();expect(p.finish).not.toHaveBeenCalled();
 }
 // A fresh but nonterminal frame cannot revive an ended local session.
 end.n++;end.stage="Combat";end.phase="Combat";end.endIntent=null;f.bus.plan=JSON.stringify(end);mock.now++;
 for(const p of f.guests){p.run.tick();expect(p.session.stage).toBe("Finished");expect(p.session.endingIntent).toBe("stopped");}
});
it.each(["expired","owner","quest","wave","session"])("ignores %s late terminal metadata without changing a completed native result",variant=>{
 const f=fixture();f.tick();f.guest.reading.quest!.status="failed";f.guest.reading.quest!.playing=false;f.tick();
 f.host.session.stop();mock.now++;f.host.run.tick();
 const frame=JSON.parse(f.bus.plan);
 if(variant==="expired")mock.now+=31;
 if(variant==="owner")f.bus.owner="other";
 if(variant==="quest")f.guest.reading.quest!.unique=8;
 if(variant==="wave")frame.token++;
 if(variant==="session")frame.s="old-session";
 f.bus.plan=JSON.stringify(frame);f.guest.session.tick();const before=f.guest.session.runSummary();f.guest.run.tick();
 expect(f.guest.session.runSummary()).toEqual(before);expect(f.guest.session.stage).toBe("Finished");
 expect(f.guest.session.endingIntent).toBe("native-ended");expect(f.guest.finish).not.toHaveBeenCalled();
});
it.each([2,3,4])("synchronizes real RunSession rules and persistent user config across %i peers without replacing wallets/current wave",size=>{
 const f=fixture(size,true);f.tick();f.clear();for(let i=0;i<4;i++)f.tick();
 expect(f.host.run.canChoose()).toBe(true);
 const peers=[f.host,...f.guests],wallets=peers.map((p,i)=>(p.core.state.wallet.pt-=i*5));
 const currentPlans=peers.map(p=>p.session.plan),originalStart=f.host.core.config.startPt,originalCarts=f.host.core.config.maxCarts;
 const cfg=f.host.userConfig(),next={...cfg,startPt:321,maxCarts:5,
  shop:cfg.shop.map((item,i)=>i===0?{...item,price:1}:item),scaling:{...cfg.scaling,hpBase:1.3}};
 const serial=f.host.run.proposeConfig(next);expect(f.host.session.canShop()).toBe(false);expect(f.host.run.canChoose()).toBe(false);
 for(let i=0;i<12;i++)f.tick();
 expect(f.host.run.configResult(serial)?.status).toBe("applied");expect(f.host.run.canChoose()).toBe(true);
 peers.forEach((p,i)=>{
   expect(p.core.state.wallet.pt).toBe(wallets[i]);expect(p.session.plan).toStrictEqual(currentPlans[i]);
   expect(p.core.config.startPt).toBe(originalStart);expect(p.core.config.maxCarts).toBe(originalCarts);
   expect(p.core.config.shop[0]!.price).toBe(1);expect(p.core.config.scaling.hpBase).toBe(1.3);
   const stored=JSON.parse(p.files[CONFIG_FILE]!);expect(stored.quest.id).toBe(900102);expect(stored.startPt).toBe(321);
   expect(p.session.stage).toBe("Selecting");expect(p.run.configurationRevision()).toBe(1);
 });
 // Current choices were generated before submission. Pick one unchanged, then
 // the following choice generation must use the new shared scaling formula.
 expect(f.host.session.choose(0).ok).toBe(true);f.tick();f.clear();for(let i=0;i<5;i++)f.tick();
 const choice=f.host.core.state.currentChoices[0]!,scale=f.host.core.config.scaling;
 expect(choice.hpMul).toBeCloseTo((1.3+(f.host.core.state.layer-1)*scale.hpPerLayer)*(size===2?scale.mp2Hp:scale.mp34Hp));
 expect(f.guests.every(p=>p.core.state.currentChoices[0]!.hpMul===choice.hpMul)).toBe(true);
});
it("does not fault on old gameplay frames while the config channel is delayed",()=>{
 const f=fixture(2,true);f.tick();f.clear();for(let i=0;i<4;i++)f.tick();
 f.host.run.proposeConfig({...f.host.userConfig(),shop:f.host.userConfig().shop.map(i=>({...i,price:i.price+1}))});
 f.bus.complete=false;for(let i=0;i<10;i++)f.tick();expect(f.host.session.stage).toBe("Selecting");expect(f.guest.session.stage).toBe("Selecting");
 expect(f.guest.session.canShop()).toBe(false);f.bus.complete=true;for(let i=0;i<12;i++)f.tick();
 expect(f.host.run.canChoose()).toBe(true);expect(f.guest.session.stage).toBe("Selecting");
});
it("ignores an old-sequence old-config frame even after the first new-config frame was accepted",()=>{
 const f=fixture(2,true);f.tick();f.clear();for(let i=0;i<4;i++)f.tick();const old=f.bus.plan;
 f.host.run.proposeConfig({...f.host.userConfig(),scaling:{...f.host.cfg.scaling,hpBase:1.3}});for(let i=0;i<12;i++)f.tick();
 f.bus.plan=old;mock.now++;f.guest.run.tick();expect(f.guest.session.stage).toBe("Selecting");expect(f.guest.run.valid()).toBe(true);
});
it("requires a fresh config epoch ACK even when only next-run fields changed and the active hash is identical",()=>{
 const f=fixture(2,true);f.tick();f.clear();for(let i=0;i<4;i++)f.tick();const oldAck=f.bus.acks.g;
 const oldHash=JSON.parse(f.bus.plan).h;
 f.host.run.proposeConfig({...f.host.userConfig(),startPt:321});for(let i=0;i<12;i++)f.tick();
 expect(JSON.parse(f.bus.plan).h).toBe(oldHash);expect(f.host.run.canChoose()).toBe(true);expect(f.host.run.snapshot().configEpoch).toBe(1);
 f.bus.acks.g=oldAck;mock.now++;f.host.run.tick();expect(f.host.run.canChoose()).toBe(false);
 for(let i=0;i<3;i++)f.tick();expect(f.host.run.canChoose()).toBe(true);
});
it("stops the run on a peer's persistence error, restores effective rules, and never reports applied",()=>{
 const f=fixture(2,true);f.tick();f.clear();for(let i=0;i<4;i++)f.tick();
 f.guest.diskState.fail=CONFIG_FILE;const old=f.host.core.config;
 const serial=f.host.run.proposeConfig({...f.host.userConfig(),scaling:{...old.scaling,hpBase:1.3}});
 for(let i=0;i<10;i++)f.tick();
 expect(f.host.run.configResult(serial)?.status).toBe("rejected");expect(f.host.session.stage).toBe("Fault");expect(f.guest.session.stage).toBe("Fault");
 expect(f.host.core.config.scaling).toEqual(old.scaling);expect(f.guest.core.config.scaling).toEqual(old.scaling);
 expect(f.host.finish).toHaveBeenCalledWith(true,{id:900103,unique:7});expect(f.guest.finish).not.toHaveBeenCalled();
});
it("retains live native host authority until the failure request is queued",()=>{
 const f=fixture();f.tick();const authority:boolean[]=[];f.host.finish.mockImplementation(()=>authority.push(f.host.run.valid()));
 f.host.run.fail("stop coordinator");expect(authority).toEqual([true]);expect(f.host.run.valid()).toBe(false);
});
it.each([2,3,4])("keeps a fixed %i-player multiplier even when the actor reading is temporarily smaller",(size)=>{
 const f=fixture(size);f.tick();f.clear();f.tick();
 expect(f.host.run.partySize()).toBe(size);f.guests.forEach(g=>expect(g.run.partySize()).toBe(size));
 const s=f.host.cfg.scaling,base=Math.min(s.hpCap,s.hpBase+(f.host.core.state.layer-1)*s.hpPerLayer);
 expect(f.host.core.state.currentChoices[0]!.hpMul).toBeCloseTo(base*(size===2?s.mp2Hp:s.mp34Hp));
});
it("canonicalizes nested configuration independently of insertion order",()=>{
 expect(canonical({b:[1,{y:2,x:3}],a:"中文"})).toBe(canonical({a:"中文",b:[1,{x:3,y:2}]}));
});
it("runs two peers through host choice, native staging barrier, reward replay and personal spending",()=>{
 const f=fixture();f.tick();f.clear();
 expect(f.host.session.stage).toBe("Selecting");expect(f.guest.session.stage).toBe("Selecting");
 f.tick();expect(f.host.session.canChoose()).toBe(true);expect(f.guest.session.canChoose()).toBe(false);
 expect(f.guest.session.choose(0).ok).toBe(false);expect(f.guest.session.canShop()).toBe(true);
 expect(f.host.session.choose(1).ok).toBe(true);f.host.reading.enemies=[];f.tick();
 expect(f.guest.publish).toHaveBeenCalledOnce();expect(f.guest.session.plan!.token).toBe(f.host.session.plan!.token);
 const ticket={token:f.host.session.plan!.token,ordinal:0,type:f.host.session.plan!.monsterIds[0]!,slot:2,id:3,uid:300};
 f.host.run.staged(ticket);expect(f.host.run.activate(ticket)).toBe(false);
 f.tick();f.guest.run.staged(ticket);f.tick();f.tick();expect(f.host.run.activate(ticket)).toBe(true);
 expect(f.host.run.canStage()).toBe(false);f.tick();expect(f.guest.run.activate(ticket)).toBe(true);f.tick();f.tick();
 expect(f.host.run.canStage()).toBe(true);
 f.guest.core.state.wallet.pt-=15;
 f.clear();const reward=f.host.session.plan!.wave.rewardPt;
 expect(f.guest.core.state.wallet.pt).toBe(f.guest.cfg.startPt-15+reward);
 const once=f.guest.core.state.wallet.pt;f.tick();f.tick();expect(f.guest.core.state.wallet.pt).toBe(once);
 expect(f.guest.session.core.state.layer).toBe(3);expect(f.guest.finish).not.toHaveBeenCalled();
});
it("blocks next choice while a guest transaction is busy",()=>{
 const f=fixture();f.tick();f.clear();f.tick();f.guest.setBusy(true);f.tick();f.tick();
 expect(f.host.session.canChoose()).toBe(false);f.guest.setBusy(false);f.tick();f.tick();expect(f.host.session.canChoose()).toBe(true);
});
it("stops every writer on roster change, and never makes guest finish the native quest",()=>{
 const f=fixture();f.tick();f.bus.members=["h"];f.tick();
 expect(f.host.run.valid()).toBe(false);expect(f.guest.run.valid()).toBe(false);
 expect(f.host.session.stage).toBe("Fault");expect(f.guest.session.stage).toBe("Fault");
 expect(f.guest.finish).not.toHaveBeenCalled();
});
it("rejects config drift before the guest ACKs a frame",()=>{
 const f=fixture();f.host.run.tick();const frame=JSON.parse(f.bus.plan);frame.h="a".repeat(64);f.bus.plan=JSON.stringify(frame);
 f.guest.run.tick();expect(f.guest.session.stage).toBe("Fault");expect(f.bus.acks.g).toContain("R4ERR|");
});
it("ignores duplicate sequence numbers and does not replay an old reward",()=>{
 const f=fixture();f.tick();f.clear();f.tick();const old=f.bus.plan;
 f.guest.core.state.wallet.pt-=10;const pt=f.guest.core.state.wallet.pt;
 mock.now++;f.bus.plan=old;f.guest.run.tick();expect(f.guest.core.state.wallet.pt).toBe(pt);
});
it("times out a silent guest rather than spawning without acknowledgement",()=>{
 const f=fixture();f.host.run.tick();mock.now+=121;f.host.run.tick();expect(f.host.session.stage).toBe("Fault");
});

it("mirrors shared cart recovery once without charging the guest wallet",()=>{
 const f=fixture();f.tick();f.host.core.state.cartRestoreUsed=true;f.host.reading.deaths=1;
 const pt=f.guest.core.state.wallet.pt;f.tick();f.tick();
 expect(f.guest.mirrorCartRestore).toHaveBeenCalledOnce();expect(f.guest.mirrorCartRestore).toHaveBeenCalledWith(1);
 expect(f.guest.core.state.wallet.pt).toBe(pt);expect(f.guest.core.state.cartRestoreUsed).toBe(true);
});
it("ignores an older host sequence after a newer one and refuses a new session envelope",()=>{
 const f=fixture();f.tick();const old=f.bus.plan;f.tick();f.bus.plan=old;mock.now++;f.guest.run.tick();
 expect(f.guest.session.stage).not.toBe("Fault");
 const packet=JSON.parse(old);packet.n=1000;packet.s="another-session";f.bus.plan=JSON.stringify(packet);mock.now++;f.guest.run.tick();
 expect(f.guest.session.stage).toBe("Fault");
});

it("requires all four fixed members to stage and activate the same native ticket",()=>{
 const f=fixture(4);f.tick();f.clear();f.tick();expect(f.guests.every(g=>g.session.stage==="Selecting")).toBe(true);
 expect(f.host.session.choose(2).ok).toBe(true);f.host.reading.enemies=[];f.tick();
 const ticket={token:f.host.session.plan!.token,ordinal:0,type:f.host.session.plan!.monsterIds[0]!,slot:2,id:3,uid:300};
 f.host.run.staged(ticket);f.tick();f.guests[0]!.run.staged(ticket);f.guests[1]!.run.staged(ticket);f.tick();f.tick();
 expect(f.host.run.activate(ticket)).toBe(false);
 f.guests[2]!.run.staged(ticket);f.tick();f.tick();expect(f.host.run.activate(ticket)).toBe(true);f.tick();
 f.guests.forEach(g=>expect(g.run.activate(ticket)).toBe(true));f.tick();f.tick();expect(f.host.run.canStage()).toBe(true);
});
it("follows host stop without a guest issuing native failure",()=>{
 const f=fixture();f.tick();f.host.session.stop();f.tick();
 expect(f.guest.session.stage).toBe("Finished");expect(f.guest.run.valid()).toBe(false);expect(f.guest.finish).not.toHaveBeenCalled();
});

it.each(["stop","fault"])("accepts host %s while guest delivery is unresolved and guards failure before releasing clear policy",kind=>{
 const f=fixture();f.tick();f.guest.setBusy(true);
 if(kind==="stop")f.host.session.stop();else f.host.session.failMultiplayer("host error");
 const guards=f.guest.guardFailure.mock.calls.length;
 f.tick();
 expect(f.guest.session.stage).toBe(kind==="stop"?"Finished":"Fault");
 expect(f.guest.run.valid()).toBe(false);expect(f.guest.finish).not.toHaveBeenCalled();
 expect(f.guest.guardFailure).toHaveBeenCalledTimes(guards+1);
 expect(f.guest.guardFailure).toHaveBeenLastCalledWith({id:900103,unique:7});
 expect(f.guest.guardFailure.mock.invocationCallOrder.at(-1)).toBeLessThan(f.guest.policy.mock.invocationCallOrder.at(-1)!);
 expect(f.guest.session.runSummary().ending).toEqual({intent:kind==="stop"?"stopped":"fault",native:null});
 expect(f.bus.acks.g).not.toContain("R4ERR|");
});

it("settles a terminal host reward without late loot grants or native cart writes",()=>{
 const f=fixture();f.tick();const frame=JSON.parse(f.bus.plan),before=f.guest.core.state.wallet.pt;
 Object.assign(frame,{n:frame.n+1,stage:"Finished",phase:"GameOver",endIntent:"stopped",earned:80,cartUsed:true});
 frame.w[3]="ultimate";f.bus.plan=JSON.stringify(frame);mock.now++;f.guest.run.tick();
 expect(f.guest.session.stage).toBe("Finished");expect(f.guest.core.state.wallet.pt).toBe(before+80);
 expect(f.guest.session.runSummary().clearedWaves).toBe(1);
 expect(f.guest.ultimateDrop).not.toHaveBeenCalled();expect(f.guest.mirrorCartRestore).not.toHaveBeenCalled();
 expect((f.guest.session as any).pendingSupplies).toEqual([]);
 expect(f.guest.session.runSummary().ending.native).toBeNull();
});

it("does not guard native failure for a completed host run",()=>{
 const f=fixture();f.tick();const frame=JSON.parse(f.bus.plan);
 Object.assign(frame,{n:frame.n+1,stage:"Finished",phase:"GameOver",endIntent:"cleared-all"});
 f.bus.plan=JSON.stringify(frame);mock.now++;f.guest.run.tick();
 expect(f.guest.session.stage).toBe("Finished");expect(f.guest.guardFailure).not.toHaveBeenCalled();
 expect(f.guest.finish).not.toHaveBeenCalled();expect(f.guest.session.runSummary().ending.native).toBeNull();
});

it("rejects an ending for a replaced native instance before changing wallets or failure guards",()=>{
 const f=fixture();f.tick();const wallet=f.guest.core.state.wallet.pt;
 f.host.session.stop();mock.now++;f.host.run.tick();
 f.guest.reading.quest!.unique=999;f.guest.run.tick();
 expect(f.guest.session.stage).toBe("Fault");expect(f.guest.session.questUniqueSnapshot).toBe(7);
 expect(f.guest.core.state.wallet.pt).toBe(wallet);expect(f.guest.guardFailure).not.toHaveBeenCalled();
 expect(f.guest.finish).not.toHaveBeenCalled();expect(f.bus.acks.g).not.toContain("R4ERR|");
});

it("does not revive a terminal guest when a delayed gameplay frame arrives",()=>{
 const f=fixture();f.tick();const old=JSON.parse(f.bus.plan);f.guest.setBusy(true);
 f.host.session.stop();f.tick();expect(f.guest.session.stage).toBe("Finished");
 const guards=f.guest.guardFailure.mock.calls.length,pt=f.guest.core.state.wallet.pt;
 f.bus.plan=JSON.stringify({...old,n:old.n+100});mock.now++;f.guest.run.tick();
 expect(f.guest.session.stage).toBe("Finished");expect(f.guest.core.state.wallet.pt).toBe(pt);
 expect(f.guest.guardFailure).toHaveBeenCalledTimes(guards);expect(f.guest.finish).not.toHaveBeenCalled();
});

it("propagates guest stop immediately and guards success before releasing local policy",()=>{
 const f=fixture();f.tick();f.guest.session.stop();
 expect(f.guest.guardFailure).toHaveBeenCalledOnce();
 expect(f.guest.guardFailure.mock.invocationCallOrder[0]).toBeLessThan(f.guest.policy.mock.invocationCallOrder.at(-1)!);
 f.tick();expect(f.bus.acks.g).toMatch(/^R4ERR\|s\|/);
 expect(f.guest.run.valid()).toBe(false);expect(f.guest.finish).not.toHaveBeenCalled();
 f.tick();expect(f.host.session.stage).toBe("Finished");expect(f.host.finish).toHaveBeenCalledWith(true,{id:900103,unique:7});
 expect(f.host.run.snapshot().message).toContain("队友已请求停止");
});

it("propagates a guest fault outside the coordinator instead of waiting for a timeout",()=>{
 const f=fixture();f.tick();f.guest.session.failMultiplayer("frame callback failed");
 f.tick();f.tick();expect(f.host.session.stage).toBe("Fault");
 expect(f.host.finish).toHaveBeenCalledWith(true,{id:900103,unique:7});expect(f.guest.finish).not.toHaveBeenCalled();
});

it("retries a lost guest abort publication and retires it when native failure arrives",()=>{
 const f=fixture();f.tick();const ack=f.guest.network.steam_ack!;
 const publish=vi.fn().mockImplementationOnce(()=>{throw new Error("temporary Steam failure");}).mockImplementation(ack);
 f.guest.network.steam_ack=publish;f.guest.session.stop();f.tick();
 expect(f.host.session.stage).not.toBe("Finished");f.tick();f.tick();expect(f.host.session.stage).toBe("Finished");
 f.guest.reading.quest!.status="failed";f.guest.reading.quest!.playing=false;f.tick();
 const calls=publish.mock.calls.length;f.tick();expect(publish).toHaveBeenCalledTimes(calls);
});

it("does not turn an already-ended native guest quest into an abort of the host",()=>{
 const f=fixture();f.tick();f.guest.reading.quest!.playing=false;f.guest.reading.quest!.status="failed";
 f.tick();expect(f.guest.session.stage).toBe("Finished");expect(f.bus.acks.g).not.toContain("R4ERR|");
 expect(f.guest.guardFailure).not.toHaveBeenCalled();expect(f.host.finish).not.toHaveBeenCalled();
});

it("never guards or aborts a different native instance when an old guest is stopped",()=>{
 const f=fixture();f.tick();f.guest.reading.quest!.unique=999;f.guest.session.stop();f.tick();
 expect(f.guest.guardFailure).not.toHaveBeenCalled();expect(f.bus.acks.g).not.toContain("R4ERR|");
 expect(f.host.finish).not.toHaveBeenCalled();
});

it("does not let host stop finish a newly accepted instance with the same quest number",()=>{
 const f=fixture();f.tick();f.host.reading.quest!.unique=999;f.host.session.stop();
 expect(f.host.finish).not.toHaveBeenCalled();expect(f.host.guardFailure).not.toHaveBeenCalled();
});

it("does not let stale one-host-test text appear as production multiplayer semantics",()=>{
 const f=fixture();expect(f.host.session.message).not.toContain("真实队友加入后停止");
 expect(f.guest.session.message).not.toContain("真实队友加入后停止");
});

it("expires cached guest ACKs while Selecting and eventually faults the silent peer",()=>{
 const f=fixture();f.tick();f.clear();f.tick();expect(f.host.session.canChoose()).toBe(true);
 const frozen=f.bus.acks.g;mock.now+=16;f.host.session.tick();f.host.run.tick();
 expect(f.host.session.canChoose()).toBe(false);expect(f.host.run.valid()).toBe(true);
 mock.now+=121;f.host.session.tick();f.host.run.tick();
 expect(f.bus.acks.g).toBe(frozen);expect(f.host.run.valid()).toBe(false);expect(f.host.session.stage).toBe("Fault");
});
it("does not refresh liveness from a delayed old ACK or an unpublished future sequence",()=>{
 const f=fixture();f.tick();f.clear();f.tick();const frozen=f.bus.acks.g;
 mock.now+=16;f.host.session.tick();f.host.run.tick();expect(f.host.session.canChoose()).toBe(false);
 f.bus.acks.g=frozen.slice(0,frozen.lastIndexOf("|")+1)+"9999999";
 mock.now++;f.host.run.tick();expect(f.host.session.canChoose()).toBe(false);
});
it("keeps a responsive guest ready while state stays unchanged for over 120 seconds",()=>{
 const f=fixture();f.tick();f.clear();for(let i=0;i<140;i++)f.tick();
 expect(f.host.run.valid()).toBe(true);expect(f.host.session.canChoose()).toBe(true);
});

it("keeps native terminal state terminal even after the quest lobby becomes unavailable", () => {
 const f=fixture();f.tick();f.host.reading.quest!.status="failed";f.host.reading.quest!.playing=false;
 f.guest.reading.quest!.status="failed";f.guest.reading.quest!.playing=false;
 mock.valid=false;f.tick();
 expect(f.host.session.stage).toBe("Finished");expect(f.guest.session.stage).toBe("Finished");
 expect(f.host.run.valid()).toBe(false);expect(f.guest.run.valid()).toBe(false);
 expect(f.guest.finish).not.toHaveBeenCalled();
});


it("awards personal supplies once on a zero-PT clear instead of tying loot to wallet deltas",()=>{
 const f=fixture();f.guest.cfg.supplyDrops={chance:1,entries:[{itemId:"honey",count:1,weight:1}]};
 f.tick();f.clear();expect(f.guest.session.runSummary().clearedWaves).toBe(1);
 const pending=(f.guest.session as any).pendingSupplies;expect(pending).toHaveLength(1);
 f.tick();f.tick();expect(pending).toHaveLength(1);
});
