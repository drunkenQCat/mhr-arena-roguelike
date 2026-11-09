import {createHash} from "node:crypto";
import {beforeEach,expect,it,vi} from "vitest";
import {MultiplayerConfig, type ConfigHooks} from "./multiplayer_config";
import type {NativeWebconsole} from "./sdk";
const time=vi.hoisted(()=>({now:100}));
vi.mock("./sdk",()=>({clockSeconds:()=>time.now,rejson:{dump_string:JSON.stringify,load_string:JSON.parse}}));
const digest=(text:string)=>createHash("sha256").update(text).digest("hex");
interface Rules {price:number;hp:number}
function fixture(size=2) {
  const members=["h","g","g2","g3"].slice(0,size);
  const bus={control:"",payload:"",complete:true,owner:"h",members:[...members],acks:{} as Record<string,string>,
    payloadOk:true,controlOk:true,ackOk:true};
  const make=(self:string)=>{
    let rules:Rules={price:10,hp:1};const original={...rules};let saved={...rules};
    const env={ready:true,token:9,layer:2,reject:false,applyError:false,finishError:false,wallet:123,oldWave:{hp:1,reward:80}};
    const validate=vi.fn((body:string)=>{
      const next=JSON.parse(body) as Rules;
      if(env.reject||!Number.isFinite(next.hp)||next.hp<=0||!Number.isFinite(next.price)||next.price<0)throw new Error("catalog/schema rejected");
      return {value:next,effectiveHash:digest(JSON.stringify(next))};
    });
    const apply=vi.fn((next:Rules)=>{rules={...next};if(env.applyError)throw new Error("apply failed");});
    const finish=vi.fn((next:Rules)=>{if(env.finishError)throw new Error("disk failed");saved={...next};});
    const restore=vi.fn(()=>{rules={...original};saved={...original};});
    const fail=vi.fn();
    const hooks:ConfigHooks<Rules>={boundary:()=>env,currentHash:()=>digest(JSON.stringify(rules)),validate,apply,finish,restore,fail};
    const network:NativeWebconsole={ping:x=>x,epoch:()=>1,take_commands:()=>[],publish_state:()=>{},publish_results:()=>{},steam_digest:digest,
      steam_snapshot:()=>({available:true,reason:"",lobbies:[{id:"l",owner:bus.owner,self,plan:"gameplay untouched",
        config:{control:bus.control,payload:bus.payload,digest:digest(bus.payload),complete:bus.complete},
        members:bus.members.map(id=>({id,ack:"gameplay ACK untouched",configAck:bus.acks[id]??""}))}]}),
      steam_config_payload:(_l,body)=>{if(!bus.payloadOk)return false;bus.payload=body;return true;},
      steam_config_control:(_l,body)=>{if(!bus.controlOk)return false;bus.control=body;return true;},
      steam_config_ack:(_l,body)=>{if(!bus.ackOk)return false;bus.acks[self]=body;return true;}};
    const sync=new MultiplayerConfig({lobby:"l",owner:"h",self,session:"s",members},hooks,network);
    return {sync,env,apply,finish,restore,fail,validate,network,rules:()=>rules,saved:()=>saved};
  };
  const peers=members.map(make),host=peers[0]!,guest=peers[1]!;
  const tick=(n=1)=>{for(let i=0;i<n;i++){time.now++;for(const p of peers)p.sync.tick();}};
  const propose=()=>host.sync.propose(JSON.stringify({price:15,hp:1.5}));
  return{bus,peers,host,guest,tick,propose};
}
beforeEach(()=>{time.now=100;});
it.each([2,3,4])("commits only after every one of %i peers validates, preserves personal wallets and current wave",size=>{
 const f=fixture(size);f.peers.forEach((p,i)=>p.env.wallet-=i*10);
 const wallets=f.peers.map(p=>p.env.wallet),wave=f.host.env.oldWave;
 const id=f.propose();expect(f.host.sync.busy()).toBe(true);f.tick();
 expect(f.peers.every(p=>p.apply.mock.calls.length===0)).toBe(true);
 f.tick(8);
 for(const p of f.peers){expect(p.rules()).toEqual({price:15,hp:1.5});expect(p.saved()).toEqual(p.rules());
   expect(p.apply).toHaveBeenCalledOnce();expect(p.finish).toHaveBeenCalledOnce();expect(p.fail).not.toHaveBeenCalled();expect(p.sync.busy()).toBe(false);}
 expect(f.host.sync.result(id)?.status).toBe("applied");
 expect(f.peers.map(p=>p.env.wallet)).toEqual(wallets);expect(f.host.env.oldWave).toBe(wave);
 f.tick(10);f.peers.forEach(p=>expect(p.apply).toHaveBeenCalledOnce());
});
it("never applies incomplete or mismatched cached chunks",()=>{
 const f=fixture();f.propose();f.bus.complete=false;f.tick(5);expect(f.host.apply).not.toHaveBeenCalled();expect(f.guest.apply).not.toHaveBeenCalled();
 f.bus.complete=true;const original=f.bus.payload;f.bus.payload=JSON.stringify({price:99,hp:1.5});f.tick(5);
 expect(f.guest.validate).not.toHaveBeenCalled();f.bus.payload=original;f.tick(8);expect(f.guest.rules().price).toBe(15);
});
it("waits for an existing guest transaction and locks before sending READY",()=>{
 const f=fixture();f.guest.env.ready=false;f.propose();f.tick(4);
 expect(f.guest.sync.busy()).toBe(true);expect(f.guest.validate).not.toHaveBeenCalled();expect(f.host.apply).not.toHaveBeenCalled();
 f.guest.env.ready=true;f.tick(8);expect(f.host.sync.result(1)?.status).toBe("applied");
});
it("cancels a rejected proposal with no rule or disk changes",()=>{
 const f=fixture();f.guest.env.reject=true;f.propose();f.tick(8);
 f.peers.forEach(p=>{expect(p.apply).not.toHaveBeenCalled();expect(p.finish).not.toHaveBeenCalled();expect(p.fail).not.toHaveBeenCalled();expect(p.sync.busy()).toBe(false);});
 expect(f.host.sync.result(1)?.status).toBe("rejected");
});
it("does not use old-session or old-proposal READY acknowledgements",()=>{
 const f=fixture();f.propose();f.tick();const old=f.bus.acks.g!;
 f.host.sync.cancel();f.tick(5);expect(f.host.sync.result(1)?.status).toBe("rejected");
 f.propose();f.bus.acks.g=old;time.now++;f.host.sync.tick();expect(f.host.apply).not.toHaveBeenCalled();
 f.tick(8);expect(f.host.sync.result(2)?.status).toBe("applied");
});
it("does not regress from commit to a delayed prepare or apply twice",()=>{
 const f=fixture();f.propose();const prepare=f.bus.control;f.tick(2);
 expect(f.guest.apply).toHaveBeenCalledOnce();const commit=f.bus.control;
 f.bus.control=prepare;time.now++;f.guest.sync.tick();expect(f.guest.apply).toHaveBeenCalledOnce();
 f.bus.control=commit;f.tick(8);expect(f.guest.apply).toHaveBeenCalledOnce();expect(f.host.sync.result(1)?.status).toBe("applied");
});
it("cancels before commit but refuses cancellation after commit",()=>{
 const f=fixture();f.propose();f.tick(2);expect(()=>f.host.sync.cancel()).toThrow("不能单端取消");f.tick(7);
});
it.each(["applyError","finishError"] as const)("rolls back and stops on %s after partial commit",key=>{
 const f=fixture();f.guest.env[key]=true;f.propose();f.tick(10);
 expect(f.guest.fail).toHaveBeenCalled();expect(f.host.fail).toHaveBeenCalled();
 expect(f.host.restore).toHaveBeenCalled();expect(f.guest.restore).toHaveBeenCalled();
 f.peers.forEach(p=>expect(p.rules()).toEqual({price:10,hp:1}));
 expect(f.host.sync.result(1)?.status).toBe("rejected");
});
it.each(["owner","members"] as const)("stops on fixed %s drift, never substitutes another peer",key=>{
 const f=fixture();f.propose();if(key==="owner")f.bus.owner="g";else f.bus.members=["h","stranger"];
 f.tick();f.peers.forEach(p=>{expect(p.fail).toHaveBeenCalled();expect(p.apply).not.toHaveBeenCalled();});
});
it("refuses a commit not previously validated even with a complete payload",()=>{
 const f=fixture();f.propose();const c=JSON.parse(f.bus.control);c.phase="commit";f.bus.control=JSON.stringify(c);
 time.now++;f.guest.sync.tick();expect(f.guest.apply).not.toHaveBeenCalled();expect(f.guest.fail).toHaveBeenCalled();
});
it("rejects same-serial payload changes and wrong boundary tokens",()=>{
 const f=fixture();f.propose();f.tick();const c=JSON.parse(f.bus.control);c.newHash="a".repeat(64);f.bus.control=JSON.stringify(c);
 time.now++;f.guest.sync.tick();expect(f.guest.fail).toHaveBeenCalled();expect(f.guest.apply).not.toHaveBeenCalled();
 const g=fixture();g.propose();g.guest.env.token++;time.now++;g.guest.sync.tick();expect(g.guest.fail).toHaveBeenCalled();
});
it("times out prepare into cancellation and stops a stranded committed barrier",()=>{
 const f=fixture();f.propose();time.now+=46;f.host.sync.tick();expect(JSON.parse(f.bus.control).phase).toBe("cancel");
 expect(f.host.apply).not.toHaveBeenCalled();f.tick(5);expect(f.host.sync.result(1)?.status).toBe("rejected");
 const g=fixture();g.propose();g.tick(2);time.now+=46;g.host.sync.tick();expect(g.host.fail).toHaveBeenCalled();expect(g.host.restore).toHaveBeenCalled();
});
it("reports failed payload submission as a rejected transaction instead of pretending success",()=>{
 const f=fixture();f.bus.payloadOk=false;f.propose();f.tick(6);
 expect(f.host.sync.result(1)?.status).toBe("rejected");f.peers.forEach(p=>expect(p.apply).not.toHaveBeenCalled());
});
it("requires owner, wave boundary and complete native bridge capabilities",()=>{
 const f=fixture();expect(()=>f.guest.sync.propose("{}")).toThrow("仅当前房主");f.host.env.ready=false;expect(f.propose).toThrow("集结");
 expect(()=>new MultiplayerConfig({lobby:"l",owner:"h",self:"h",session:"s",members:["h","g"]},{} as ConfigHooks<Rules>,{} as NativeWebconsole)).toThrow("新版");
});
it("keeps already-persisted peers locked until all peers finish, then rolls them back if the last disk fails",()=>{
 const f=fixture(4);f.peers[3]!.env.finishError=true;f.propose();f.tick(3);
 expect(f.peers[1]!.finish).toHaveBeenCalledOnce();expect(f.peers[1]!.sync.busy()).toBe(true);
 f.tick(5);
 for(const p of f.peers){expect(p.fail).toHaveBeenCalled();expect(p.rules()).toEqual({price:10,hp:1});expect(p.saved()).toEqual({price:10,hp:1});}
});
it("rejects a timed-out guest's late commit instead of reviving its old READY",()=>{
 const f=fixture();f.propose();f.tick();time.now+=46;
 f.guest.sync.tick();expect(JSON.parse(f.bus.acks.g!).status).toBe("rejected");
 const c=JSON.parse(f.bus.control);c.phase="commit";f.bus.control=JSON.stringify(c);time.now++;f.guest.sync.tick();
 expect(f.guest.apply).not.toHaveBeenCalled();expect(JSON.parse(f.bus.acks.g!).status).toBe("rejected");
});
it("cancels rather than committing if the host's local transaction boundary becomes busy",()=>{
 const f=fixture();f.propose();f.tick();f.host.env.ready=false;f.tick(5);
 expect(f.host.apply).not.toHaveBeenCalled();expect(f.host.sync.result(1)?.status).toBe("rejected");
});
