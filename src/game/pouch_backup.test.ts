import { beforeEach, expect, it, vi } from "vitest";
const h=vi.hoisted(()=>({bag:[] as any[],backup:null as any,saved:null as any,failClear:false,failRead:false,failSave:false}));
const list=(items:any[])=>({call:(m:string,i:number)=>m==="get_Count"?items.length:{call:(n:string)=>n==="get_ItemId"?items[i].id:items[i].n}});
vi.mock("./sdk",()=>({
  getSingleton:()=>({get_field:()=>({call:(m:string,t:number)=>{
    if(m==="getInventoryDataList") {if(h.failRead)throw Error("unreadable");return list(h.bag[t]);}
    if(m==="get_BackupInventoryDataList")return h.backup?{call:(n:string,i:number)=>n==="get_Count"?6:list(h.backup[i])}:null;
    if(m==="saveToBackupInventory")h.backup=structuredClone(h.bag);
    if(m==="clear") {if(h.failClear&&t===2)throw Error("partial");h.bag[t]=[];}
    if(m==="loadFromBackupInventory") {if(h.backup)h.bag=structuredClone(h.backup);}
  }})}),
  findTypeDefinition:()=>({get_fields:()=>["Normal","Temporary","BulletBottle","Regular","WireJumpInsect","OtDogItemPouch"].map((name,i)=>({get_name:()=>name,is_static:()=>true,get_data:()=>i}))}),
  rejson:{load_file:()=>h.saved,dump_file:(_p:string,d:any)=>{if(h.failSave)return false;h.saved=structuredClone(d);return true;}},
  relog:{info:vi.fn(),warn:vi.fn(),error:vi.fn()}
}));
import {beginPouchIsolation,endPouchIsolation} from "./pouch_backup";
beforeEach(()=>{h.failClear=false;h.failRead=false;h.failSave=false;h.bag=Array.from({length:6},()=>[]);h.backup=structuredClone(h.bag);h.saved=null;endPouchIsolation();h.bag[0]=[{id:1,n:10}];h.bag[2]=[{id:2,n:20}];});
it("backs up first, clears only player categories, and exactly restores IDs and counts",()=>{
  const before=structuredClone(h.bag);expect(beginPouchIsolation().ok).toBe(true);
  expect(h.bag[0]).toEqual([]);expect(h.bag[2]).toEqual([]);
  expect(endPouchIsolation().ok).toBe(true);expect(h.bag).toEqual(before);
});
it("refuses a second begin without overwriting the original backup",()=>{
  expect(beginPouchIsolation().ok).toBe(true);expect(beginPouchIsolation().ok).toBe(false);
  expect(h.backup[0][0].n).toBe(10);
});
it("partial clear failure remains recoverable",()=>{
  h.failClear=true;expect(beginPouchIsolation().ok).toBe(false);expect(h.bag[0]).toEqual([]);
  expect(endPouchIsolation().ok).toBe(true);expect(h.bag[0][0].n).toBe(10);
});
it("a genuinely empty original pouch restores successfully",()=>{
  h.bag=Array.from({length:6},()=>[]);expect(beginPouchIsolation().ok).toBe(true);expect(endPouchIsolation().ok).toBe(true);
});
it("missing and overwritten backups do not masquerade as empty/successful recovery",()=>{
  beginPouchIsolation();h.backup=null;expect(endPouchIsolation().ok).toBe(false);expect(h.saved.active).toBe(true);
  h.backup=Array.from({length:6},()=>[]);expect(endPouchIsolation().ok).toBe(false);
});
it("journal failure prevents clearing; failed reads never prove recovery",()=>{
  h.failSave=true;expect(beginPouchIsolation().ok).toBe(false);expect(h.bag[0][0].n).toBe(10);
  h.failSave=false;beginPouchIsolation();h.failRead=true;expect(endPouchIsolation().ok).toBe(false);expect(h.saved.active).toBe(true);
});
