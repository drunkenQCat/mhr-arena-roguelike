import {beforeEach,expect,it,vi} from "vitest";
const h=vi.hoisted(()=>({equipment:null as any,pouch:null as any,retireEquip:vi.fn(),retirePouch:vi.fn()}));
vi.mock("./sdk",()=>({rejson:{dump_string:(v:unknown)=>JSON.stringify(v)}}));
vi.mock("./equip_wear",()=>({startupCommitRecord:()=>h.equipment,persistStartupState:(v:any)=>h.retireEquip(v)}));
vi.mock("./pouch_backup",()=>({pouchCommitRecord:()=>h.pouch,retirePouchCommit:()=>h.retirePouch()}));
import {captureRecoveryCommit,commitRecovery} from "./recovery_commit";
beforeEach(()=>{Object.assign(h,{equipment:{active:true,phase:"restored",id:1},pouch:{active:true,items:{'0':{'1':10}}}});h.retireEquip.mockReset().mockReturnValue(true);h.retirePouch.mockReset().mockReturnValue(true);});
it("certifies the exact original journals and does not retire a changed generation",()=>{
 const token=captureRecoveryCommit()!;h.equipment.id=2;expect(()=>commitRecovery(token)).toThrow("changed");
 expect(h.retirePouch).not.toHaveBeenCalled();expect(h.retireEquip).not.toHaveBeenCalled();
});
it("retains the linked pouch if equipment retirement fails and can retry a pouch-only remainder",()=>{
 const token=captureRecoveryCommit()!;h.retireEquip.mockReturnValue(false);
 expect(()=>commitRecovery(token)).toThrow("equipment");expect(h.retirePouch).not.toHaveBeenCalled();
 h.retireEquip.mockReturnValue(true);h.retirePouch.mockReturnValue(false);
 expect(()=>commitRecovery(token)).toThrow("pouch");expect(h.retireEquip).toHaveBeenCalledWith(null);
 h.equipment=null;h.retirePouch.mockReturnValue(true);commitRecovery(captureRecoveryCommit()!);
 expect(h.retirePouch).toHaveBeenCalledTimes(2);
});
it("does not certify active un-restored or absent journals",()=>{
 h.equipment=undefined;expect(captureRecoveryCommit()).toBeNull();h.equipment=null;h.pouch=null;expect(captureRecoveryCommit()).toBeNull();
});

it("requires the linked original pouch even if equipment is already restored",()=>{
 h.equipment.pouchIsolated=true;h.pouch=null;expect(captureRecoveryCommit()).toBeNull();
 expect(()=>commitRecovery("old")).toThrow("changed");expect(h.retireEquip).not.toHaveBeenCalled();
});
