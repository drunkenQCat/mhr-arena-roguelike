import {beforeEach,expect,it,vi} from "vitest";
const h=vi.hoisted(()=>({hooks:new Map<string,any>(),state:1,result:2,failed:false,slot:1,snow:1,
  time:0,agentState:0,requests:0,questActive:false,canPost:true,idle:true,
  owner:{character:"hunter",slot:0,name:"hunter",process:"p1"}}));
vi.mock("./recovery_owner",()=>({readRecoveryOwner:()=>({...h.owner})}));
vi.mock("./sdk",()=>({PRE_HOOK:{CALL_ORIGINAL:0},
  clockSeconds:()=>h.time,
  createInstance:()=>({add_ref:()=>{},get_field:()=>h.agentState,call:(name:string)=>{if(name.startsWith("requestSaveAll")){h.agentState=1;h.requests++;return;}if(name==="takeResult"){const result=h.agentState===3;h.agentState=0;return result;}}}),
  findTypeDefinition:(type:string)=>({get_method:(name:string)=>({key:type+"."+name,call:()=>({
    get_SaveState:h.state,get_LastSaveResult:h.result,get_LastSaveFailed:h.failed,get_SaveSlotLast:h.slot
  } as Record<string,unknown>)[name]})}),
  getSingleton:()=>({get_field:()=>h.snow,call:(name:string)=>({isActiveQuest:h.questActive,IsCanInvokeQuestBoard:h.canPost,isIdle:h.idle}[name])}),
  hookMethod:(method:any,pre:any,post:any)=>h.hooks.set(method.key,{pre,post})
}));
import {RecoverySave} from "./recovery_save";
function setup(){
  const callbacks={prepare:vi.fn(),capture:vi.fn(()=>"original" as string|null),commit:vi.fn(),report:vi.fn()};
  const observer=new RecoverySave(callbacks),save=h.hooks.get("snow.SnowSaveService.saveCharaData"),update=h.hooks.get("snow.SnowSaveService.doUpdate");
  const start=()=>{save.pre();h.state=18;h.result=1;save.post(0);};
  const success=()=>{h.state=1;h.result=2;h.slot=1;h.failed=false;update.pre();};
  return {callbacks,observer,save,update,start,success};
}
beforeEach(()=>{h.hooks.clear();Object.assign(h,{state:1,result:2,failed:false,slot:1,snow:1,
 time:0,agentState:0,requests:0,questActive:false,canPost:true,idle:true,
 owner:{character:"hunter",slot:0,name:"hunter",process:"p1"}});});
it("restores before native serialization and retires only after a fresh character save succeeds",()=>{
 const f=setup();f.start();expect(f.callbacks.prepare).toHaveBeenCalledOnce();
 expect(f.callbacks.prepare.mock.invocationCallOrder[0]).toBeLessThan(f.callbacks.capture.mock.invocationCallOrder[0]);
 f.observer.tick();expect(f.callbacks.commit).not.toHaveBeenCalled();f.success();
 expect(f.callbacks.commit).not.toHaveBeenCalled();f.observer.tick();expect(f.callbacks.commit).toHaveBeenCalledOnce();expect(f.callbacks.commit).toHaveBeenCalledWith("original");
 f.observer.tick();expect(f.callbacks.commit).toHaveBeenCalledOnce();
});

it("requests the managed save agent only in native update and requires a new matching character write plus callback",()=>{
 const f=setup(),serial=f.observer.request();expect(h.requests).toBe(0);f.observer.tick();expect(f.observer.requestResult(serial)).toBe(null);
 f.update.post(0);expect(h.requests).toBe(1);expect(()=>f.observer.request()).toThrow("仍在进行");
 h.state=18;h.result=1;f.update.pre();h.state=1;h.result=2;h.slot=1;f.update.pre();
 expect(f.observer.requestResult(serial)).toBe(null);h.agentState=3;f.observer.tick();
 expect(f.observer.requestResult(serial)).toMatchObject({status:"applied",characterSaved:true,slot:0});
 f.update.post(0);f.observer.tick();expect(h.requests).toBe(1);
});
it("does not claim save success for an old/system-only result even when the agent callback succeeds",()=>{
 const f=setup(),serial=f.observer.request();f.update.post(0);h.agentState=3;f.observer.tick();
 expect(f.observer.requestResult(serial)).toMatchObject({status:"uncertain",characterSaved:false});
});
it("revalidates village and character immediately before requesting a save",()=>{
 const f=setup(),serial=f.observer.request();h.owner.character="other";f.update.post(0);
 expect(h.requests).toBe(0);expect(f.observer.requestResult(serial)?.status).toBe("rejected");
 h.questActive=true;expect(()=>f.observer.request()).toThrow("村庄保存");
});
it("times out without replaying and retains an in-flight agent until its native callback completes",()=>{
 const f=setup(),serial=f.observer.request();f.update.post(0);h.time=30;f.observer.tick();
 expect(f.observer.requestResult(serial)?.status).toBe("uncertain");expect(h.requests).toBe(1);
 expect(()=>f.observer.request()).toThrow("仍在进行");f.update.post(0);expect(h.requests).toBe(1);
});
it("does not mistake a previous successful save or a later system save for this character's commit",()=>{
 const f=setup();f.save.pre();f.save.post(0);f.update.pre();f.observer.tick();expect(f.callbacks.commit).not.toHaveBeenCalled();
 f.start();h.slot=0;h.state=1;h.result=2;f.update.pre();f.observer.tick();expect(f.callbacks.commit).not.toHaveBeenCalled();
 h.slot=1;f.update.pre();h.snow=2;h.slot=0;f.observer.tick();expect(f.callbacks.commit).toHaveBeenCalledOnce();
});
it.each([3,20,29])("retains recovery on native cancel/write failure %s",result=>{
 const f=setup();f.start();h.state=1;h.result=result;f.update.pre();f.observer.tick();expect(f.callbacks.commit).not.toHaveBeenCalled();
 f.success();f.observer.tick();expect(f.callbacks.commit).not.toHaveBeenCalled();
});
it("never retires a changed character or an unreadable native state",()=>{
 const f=setup();f.start();h.owner.character="other";f.success();f.observer.tick();expect(f.callbacks.commit).not.toHaveBeenCalled();
 h.owner.character="hunter";f.start();h.state=undefined as any;f.update.pre();f.success();f.observer.tick();expect(f.callbacks.commit).not.toHaveBeenCalled();
});
it("keeps originals when preparation/capture/commit fails and leaves the native save unmodified",()=>{
 const f=setup();f.callbacks.prepare.mockImplementationOnce(()=>{throw Error("restore failed");});
 expect(f.save.pre()).toBe(0);f.save.post(0);f.success();f.observer.tick();expect(f.callbacks.commit).not.toHaveBeenCalled();
 f.callbacks.commit.mockImplementation(()=>{throw Error("journal changed");});f.start();f.success();expect(()=>f.observer.tick()).not.toThrow();
 expect(f.callbacks.report).toHaveBeenCalledWith("recovery-save-blocked",expect.stringContaining("journal changed"));
});
it("ignores unrelated saves with no restored recovery and does not replay completed attempts",()=>{
 const f=setup();f.callbacks.capture.mockReturnValueOnce(null);f.start();f.success();f.observer.tick();expect(f.callbacks.commit).not.toHaveBeenCalled();
 f.start();f.success();f.save.pre();f.observer.tick();expect(f.callbacks.commit).not.toHaveBeenCalled();
});

it("keeps an idle/Doing transition pending until a terminal result",()=>{
 const f=setup();f.start();h.state=1;h.result=1;f.update.pre();f.observer.tick();
 expect(f.callbacks.commit).not.toHaveBeenCalled();f.success();f.observer.tick();expect(f.callbacks.commit).toHaveBeenCalledOnce();
});
it("does not certify a previous job busy when character serialization starts",()=>{
 const f=setup();h.state=18;h.result=1;f.save.pre();f.save.post(0);f.success();f.observer.tick();
 expect(f.callbacks.commit).not.toHaveBeenCalled();expect(f.callbacks.report).toHaveBeenCalledWith("recovery-save-blocked",expect.stringContaining("Previous native save"));
});
