import { beforeEach, expect, it, vi } from "vitest";
const h=vi.hoisted(()=>({bag:[] as any[],backup:null as any,saved:null as any,failClear:false,failRead:false,failSave:false,failAdd:false,writeCalls:0}));
function list(items:any[]) { return {call:(m:string,i:number)=>m==="get_Count"?items.length:{
 get_type_definition:()=>({get_method:()=>({})}),
 call:(n:string,...args:number[])=>{
  if(n==="get_ItemId")return items[i].id;
  if(n==="get_Count")return items[i].n;
  if(n==="setEmpty")items[i]={id:0,n:0};
  if(n.startsWith("add(")&&!h.failAdd)items[i]={id:args[0],n:args[1]};
 }
}}; }
vi.mock("./recovery_owner", () => ({
 readRecoveryOwner: () => ({character:"test",slot:0,name:"hunter",process:"process-1"}),
 assertRecoveryOwner: (owner: any) => {
  if (!owner || owner.character !== "test" || owner.slot !== 0) throw new Error("恢复属于其他角色或缺少身份");
  return {character:"test",slot:0,name:"hunter",process:"process-1"};
 }
}));
vi.mock("./sdk",()=>({
 loadWebconsole:()=>({write_recovery:(_p:string,text:string)=>{h.writeCalls++;if(h.failSave)return false;h.saved=JSON.parse(text);return true;}}),
 refFs: { read: () => h.saved === null ? "" : JSON.stringify(h.saved), glob: () => h.saved === null ? [] : ["mhw_rogue_startup_state.json", "mhw_rogue_pouch_state.json"] },
 getSingleton:()=>({get_field:()=>({call:(m:string,t:number)=>{
  if(m==="getInventoryDataList") {if(h.failRead)throw Error("unreadable");return list(h.bag[t]);}
  if(m==="get_BackupInventoryDataList")return h.backup?{call:(_n:string,i:number)=>list(h.backup[i])}:null;
  if(m==="saveToBackupInventory") {h.backup=structuredClone(h.bag);h.bag=empty();}
  if(m==="clear") {if(h.failClear&&t===2)throw Error("partial");h.bag[t]=empty()[t];}
  if(m==="loadFromBackupInventory"&&h.backup)h.bag=structuredClone(h.backup);
 }})}),
 findTypeDefinition:()=>({get_fields:()=>["Normal","Temporary","BulletBottle","Regular","WireJumpInsect","OtDogItemPouch"].map((name,i)=>({get_name:()=>name,is_static:()=>true,get_data:()=>i}))}),
 rejson:{dump_string:JSON.stringify,load_string: (text: string) => { try { return JSON.parse(text); } catch { return null; } },
    load_file:()=>h.saved,dump_file:(_p:string,d:any)=>{if(h.failSave)return false;h.saved=structuredClone(d);return true;}},
 relog:{info:vi.fn(),warn:vi.fn(),error:vi.fn()}
}));
const empty=()=>Array.from({length:6},()=>Array.from({length:8},()=>({id:0,n:0})));
let beginPouchIsolation:typeof import("./pouch_backup").beginPouchIsolation;
let endPouchIsolation:typeof import("./pouch_backup").endPouchIsolation;
beforeEach(async()=>{
 vi.resetModules();({beginPouchIsolation,endPouchIsolation}=await import("./pouch_backup"));
 Object.assign(h,{failClear:false,failRead:false,failSave:false,failAdd:false,writeCalls:0,bag:empty(),backup:empty(),saved:null});
 h.bag[0][0]={id:1,n:10};h.bag[2][0]={id:2,n:20};
});
it("journals before native backup moves the pouch, then restores exact original counts",()=>{
 const before=structuredClone(h.bag);expect(beginPouchIsolation().ok).toBe(true);
 expect(h.bag[0].every((x:any)=>x.n===0)).toBe(true);
 expect(endPouchIsolation().ok).toBe(true);expect(h.bag).toEqual(before);
});
it("refuses a second begin without overwriting the original backup",()=>{
 expect(beginPouchIsolation().ok).toBe(true);expect(beginPouchIsolation().ok).toBe(false);expect(h.backup[0][0].n).toBe(10);
});
it("preserves original stacks until a successful native save, including a later cold retry",async()=>{
 const before=structuredClone(h.bag);beginPouchIsolation();endPouchIsolation(true);
 expect(h.saved.active).toBe(true);expect(h.saved.restoredProcess).toBe("process-1");
 expect(beginPouchIsolation().ok).toBe(false);expect((await import("./pouch_backup")).pouchCommitRecord()).not.toBeUndefined();
 h.bag=empty();h.backup=empty();h.saved.restoredProcess="previous-process";vi.resetModules();
 const fresh=await import("./pouch_backup");expect(fresh.pouchCommitRecord()).toBeUndefined();
 expect(fresh.endPouchIsolation(true).ok).toBe(true);expect(h.bag).toEqual(before);expect(h.saved.active).toBe(true);
});
it("partial clear failure retains a recoverable obligation",()=>{
 h.failClear=true;expect(beginPouchIsolation().ok).toBe(false);expect(h.saved.active).toBe(true);
 expect(endPouchIsolation().ok).toBe(true);expect(h.bag[0][0].n).toBe(10);
});
it("restores an originally empty pouch even when the native backup was overwritten",()=>{
 h.bag=empty();beginPouchIsolation();h.bag[0][0]={id:9,n:1};h.backup=structuredClone(h.bag);
 expect(endPouchIsolation().ok).toBe(true);expect(h.bag[0][0].n).toBe(0);expect(h.saved.active).toBe(false);
});
it("reconstructs original stacks from the journal after a reload and an empty engine backup",async()=>{
 h.bag[0][1]={id:1,n:10};const before=structuredClone(h.bag);beginPouchIsolation();h.backup=empty();
 vi.resetModules();const fresh=await import("./pouch_backup");
 expect(fresh.endPouchIsolation().ok).toBe(true);expect(h.bag).toEqual(before);
});
it("retains recovery on failed native writes, including after a new Lua boot",async()=>{
 beginPouchIsolation();h.backup=null;h.failAdd=true;vi.resetModules();const fresh=await import("./pouch_backup");
 expect(fresh.endPouchIsolation().ok).toBe(false);expect(h.saved.active).toBe(true);
});
it("never treats failed reads as proof of recovery",async()=>{
 beginPouchIsolation();h.failRead=true;vi.resetModules();const fresh=await import("./pouch_backup");
 expect(fresh.endPouchIsolation().ok).toBe(false);expect(h.saved.active).toBe(true);
});
it("does not mutate the pouch when the journal cannot be saved",()=>{
 h.failSave=true;expect(beginPouchIsolation().ok).toBe(false);expect(h.bag[0][0].n).toBe(10);
});

it("does not restore or replace another character's pouch journal",()=>{
 beginPouchIsolation();h.saved.owner.character="other";const before=structuredClone(h.bag),journal=structuredClone(h.saved);
 expect(endPouchIsolation().ok).toBe(false);expect(beginPouchIsolation().ok).toBe(false);
 expect(h.bag).toEqual(before);expect(h.saved).toEqual(journal);
});

it("rejects missing categories or contradictory stack totals before clearing any live slot",()=>{
 beginPouchIsolation();h.backup=null;h.bag[0][0]={id:9,n:7};const saved=structuredClone(h.saved),bag=structuredClone(h.bag);
 for(const bad of [{...saved,items:{}},{...saved,stacks:{...saved.stacks,'0':[{id:1,n:99}]}}]) {
  h.saved=bad;expect(endPouchIsolation().ok).toBe(false);expect(h.bag).toEqual(bag);expect(h.saved).toEqual(bad);
 }
});

it("restores empty categories serialized as null by the native Lua JSON binding",async()=>{
 beginPouchIsolation();h.saved.items['1']=null;delete h.saved.items['5'];h.saved.stacks['1']=null;
 h.backup=null;vi.resetModules();const fresh=await import("./pouch_backup");
 expect(fresh.endPouchIsolation().ok).toBe(true);expect(h.bag[0][0]).toEqual({id:1,n:10});
});

it("does not flush an unchanged retained pouch record on every recovery poll",()=>{
 beginPouchIsolation();endPouchIsolation(true);const writes=h.writeCalls;
 expect(endPouchIsolation(true).ok).toBe(true);expect(h.writeCalls).toBe(writes);
 h.bag[0][0]={id:99,n:1};expect(endPouchIsolation(true).ok).toBe(true);
 expect(h.bag[0][0]).toEqual({id:1,n:10});expect(h.writeCalls).toBe(writes);
});
