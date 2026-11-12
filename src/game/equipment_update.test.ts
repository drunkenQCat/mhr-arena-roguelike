import { beforeEach, expect, it, vi } from "vitest";
const h=vi.hoisted(()=>({post:null as null|((v:unknown)=>unknown),time:0}));
vi.mock("./sdk",()=>({clockSeconds:()=>h.time,findTypeDefinition:()=>({get_method:()=>({})}),
 hookMethod:(_m:unknown,_pre:unknown,post:(v:unknown)=>unknown)=>h.post=post,relog:{error:vi.fn()}}));
let q:typeof import("./equipment_update");
beforeEach(async()=>{vi.resetModules();h.time=0;h.post=null;q=await import("./equipment_update");});
it("defers mutations to native update, coalesces and serializes them",()=>{
 const key={},run=vi.fn(()=>{expect(q.inEquipmentUpdate()).toBe(true);q.requireEquipmentUpdate();});
 expect(()=>q.requireEquipmentUpdate()).toThrow();q.enqueueEquipmentWork(key,run,vi.fn());
 q.enqueueEquipmentWork(key,run,vi.fn());expect(run).not.toHaveBeenCalled();
 h.post!(123);h.post!(123);expect(run).toHaveBeenCalledTimes(1);expect(q.inEquipmentUpdate()).toBe(false);
});
it("cancels obsolete work and refuses a delayed mutation",()=>{
 const run=vi.fn(),fail=vi.fn(),key={};q.enqueueEquipmentWork(key,run,fail);q.cancelEquipmentWork(key);h.post!(0);
 expect(run).not.toHaveBeenCalled();q.enqueueEquipmentWork(key,run,fail);h.time=11;h.post!(0);
 expect(run).not.toHaveBeenCalled();expect(fail).toHaveBeenCalledOnce();
});
it("contains an exception without replaying or blocking later work",()=>{
 const fail=vi.fn(),next=vi.fn();q.enqueueEquipmentWork({},()=>{throw new Error("uncertain");},fail);
 q.enqueueEquipmentWork({},next,vi.fn());h.post!(0);expect(next).not.toHaveBeenCalled();
 h.post!(0);expect(next).toHaveBeenCalledOnce();expect(fail).toHaveBeenCalledWith("Error: uncertain");
});
