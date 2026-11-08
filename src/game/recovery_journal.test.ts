import { beforeEach, expect, it, vi } from "vitest";
const h=vi.hoisted(()=>({exists:false,text:"",unreadable:false,writer:true,writeOk:true,readback:true}));
vi.mock("./sdk",()=>({loadWebconsole:()=>({write_recovery:h.writer?(_p:string,text:string)=>{if(!h.writeOk)return false;h.exists=true;h.text=h.readback?text:"wrong";return true;}:undefined}),refFs:{
 read:()=>{if(h.unreadable)throw new Error("cannot read");return h.text;},
 glob:()=>h.exists?["state.json"]:[]},
 rejson:{dump_string:JSON.stringify,load_string:(s:string)=>{try{return JSON.parse(s);}catch{return null;}}}}));
import { readRecoveryRecord, recoveryPending, writeRecoveryRecord, recoveryWriteFailure } from "./recovery_journal";
beforeEach(()=>Object.assign(h,{exists:false,text:"",unreadable:false,writer:true,writeOk:true,readback:true}));
it("distinguishes a missing record from a present empty, malformed, or unreadable one",()=>{
 expect(readRecoveryRecord("state.json")).toBeNull();expect(recoveryPending("state.json")).toBe(false);
 h.exists=true;
 for(const text of ["", "{", "null", "[]", '{"active":"false"}']) {
  h.text=text;expect(()=>readRecoveryRecord("state.json")).toThrow();expect(recoveryPending("state.json")).toBe(true);
 }
 h.unreadable=true;expect(recoveryPending("state.json")).toBe(true);
});
it("recognizes a verified retired record without interpreting its absent inventory as a new backup",()=>{
 h.text='{"active":false}';expect(recoveryPending("state.json")).toBe(false);
 h.text='{"active":true}';expect(recoveryPending("state.json")).toBe(true);
});

it("requires the native writer and an exact readback without using a truncating fallback",()=>{
 const file="mhw_rogue_startup_state.json";
 h.text='{"active":true,"original":1}';h.exists=true;h.writer=false;
 expect(writeRecoveryRecord(file,{active:false})).toBe(false);expect(h.text).toContain('original');expect(recoveryWriteFailure()).toContain('webconsole DLL');
 h.writer=true;h.writeOk=false;expect(writeRecoveryRecord(file,{active:false})).toBe(false);expect(h.text).toContain('original');
 h.writeOk=true;h.readback=false;expect(writeRecoveryRecord(file,{active:false})).toBe(false);expect(recoveryWriteFailure()).toContain('readback');
 h.readback=true;expect(writeRecoveryRecord(file,{active:true,original:2})).toBe(true);expect(recoveryWriteFailure()).toBeNull();
 expect(readRecoveryRecord(file)).toEqual({active:true,original:2});
});
