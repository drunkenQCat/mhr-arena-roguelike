import { beforeEach, expect, it, vi } from "vitest";
const h=vi.hoisted(()=>({exists:false,text:"",unreadable:false}));
vi.mock("./sdk",()=>({refFs:{
 read:()=>{if(h.unreadable)throw new Error("cannot read");return h.text;},
 glob:()=>h.exists?["state.json"]:[]},
 rejson:{load_string:(s:string)=>{try{return JSON.parse(s);}catch{return null;}}}}));
import { readRecoveryRecord, recoveryPending } from "./recovery_journal";
beforeEach(()=>Object.assign(h,{exists:false,text:"",unreadable:false}));
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
