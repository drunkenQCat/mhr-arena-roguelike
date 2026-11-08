import { beforeEach, expect, it, vi } from "vitest";
const h=vi.hoisted(()=>({slot:0,name:"same name",guid:1,process:"p1",missing:false}));
vi.mock("./sdk",()=>({loadWebconsole:()=>({session_id:()=>h.process}),getSingleton:(name:string)=>{
 if(h.missing)return null;
 if(name==="snow.SnowSaveService")return {call:(m:string)=>m==="getSlotNo"?h.slot:h.name};
 if(name==="snow.GuildCardManager")return {get_field:()=>({get_field:()=>({get_field:()=>({get_field:()=>h.guid})})})};
 return null;
}}));
import { assertRecoveryOwner, readRecoveryOwner } from "./recovery_owner";
beforeEach(()=>Object.assign(h,{slot:0,name:"same name",guid:1,process:"p1",missing:false}));
it("binds recovery to a stable native character ID and slot, independently of rename and process restart",()=>{
 const owner=readRecoveryOwner();h.name="renamed";h.process="p2";
 expect(assertRecoveryOwner(owner).process).toBe("p2");
 h.guid=2;expect(()=>assertRecoveryOwner(owner)).toThrow("请载入原角色");
 h.guid=1;h.slot=1;expect(()=>assertRecoveryOwner(owner)).toThrow("请载入原角色");
});
it("rejects title/default identities and unbound legacy records before any recovery write",()=>{
 h.slot=-1;expect(()=>readRecoveryOwner()).toThrow();h.slot=0;h.guid=0;expect(()=>readRecoveryOwner()).toThrow();
 h.guid=1;h.process="";expect(()=>readRecoveryOwner()).toThrow();
 expect(()=>assertRecoveryOwner(undefined)).toThrow("旧恢复记录");
});
