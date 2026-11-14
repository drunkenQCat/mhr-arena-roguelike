import { findTypeDefinition, getSingleton, hookMethod, PRE_HOOK, clockSeconds, createInstance, type REMethodDefinition, type REManagedObject } from "./sdk";
import { readRecoveryOwner, type RecoveryOwner } from "./recovery_owner";

interface SaveCallbacks {
  canRequest?(): string | null;
  prepare(): void;
  capture(): string | null;
  commit(token: string): void;
  report(event: string, detail: unknown): void;
}
interface Attempt { token: string; owner: RecoveryOwner; seenBusy: boolean }
interface SaveRequest {
  serial:number;owner:RecoveryOwner;armed:boolean;agent:REManagedObject|null;
  deadline:number;seenBusy:boolean;characterSaved:boolean;
  status:"queued"|"applied"|"rejected"|"uncertain";message:string;
}
const STORAGE="via.storage.saveService.SaveService";

/** Observe an engine-initiated CHARACTER save, including its fresh busy->success
 * transition. Explicit village requests use the game's SaveLoadAgent, which owns
 * the managed completion delegate; no direct serializer or null callback call. */
export class RecoverySave {
  private pending: Attempt | null=null;
  private completed: Attempt | null=null;
  private getters: Record<string,REMethodDefinition>={};
  private requested:SaveRequest|null=null;
  private requestSerial=0;
  constructor(private callbacks: SaveCallbacks) {
    const native=findTypeDefinition(STORAGE), snow=findTypeDefinition("snow.SnowSaveService");
    for (const name of ["get_SaveState","get_LastSaveResult","get_LastSaveFailed","get_SaveSlotLast"] as const) {
      const method=native?.get_method(name);
      if (!method) throw new Error(`Native save observation unavailable: ${name}`);
      this.getters[name]=method;
    }
    const save=snow?.get_method("saveCharaData"), update=snow?.get_method("doUpdate");
    if (!save || !update) throw new Error("Native character save hooks unavailable");
    hookMethod(save,()=>{
      this.pending=null;this.completed=null;
      try {
        this.callbacks.prepare();
        const token=this.callbacks.capture();
        if (token) {
          // Refuse to correlate an already running storage job with this call.
          if (this.value("get_SaveState")!==1 || this.value("get_LastSaveResult")===1)
            throw new Error("Previous native save still busy; recovery retained");
          this.pending={token,owner:readRecoveryOwner(),seenBusy:false};
          this.callbacks.report("recovery-save-start",{slot:this.pending.owner.slot});
        }
      } catch(error) { this.callbacks.report("recovery-save-blocked",String(error)); }
      return PRE_HOOK.CALL_ORIGINAL;
    },value=>{this.sample();return value;});
    // Read completion BEFORE SnowSaveService dequeues the following system save.
    hookMethod(update,()=>{this.sample();this.sampleRequest();return PRE_HOOK.CALL_ORIGINAL;},value=>{this.performRequest();return value;});
  }
  request():number {
    if(this.requested?.status==="queued" || this.requested?.agent?.get_field("_State")===1)throw new Error("原生保存仍在进行，请等待结果，不重复请求");
    this.requireRequestScope();
    const owner=readRecoveryOwner(),serial=++this.requestSerial;
    this.requested={serial,owner,armed:true,agent:null,deadline:clockSeconds()+25,seenBusy:false,characterSaved:false,
      status:"queued",message:"等待原生保存更新阶段"};
    return serial;
  }
  requestResult(serial:number):{status:string;message:string;slot:number;characterSaved:boolean}|null {
    const p=this.requested;if(!p||p.serial!==serial||p.status==="queued")return null;
    return {status:p.status,message:p.message,slot:p.owner.slot,characterSaved:p.characterSaved};
  }
  private requireRequestScope():void {
    const reason=this.callbacks.canRequest?.();if(reason)throw new Error(reason);
    if(getSingleton("snow.QuestManager")?.call("isActiveQuest")!==false ||
      getSingleton("snow.gui.GuiManager")?.call("IsCanInvokeQuestBoard")!==true)
      throw new Error("请在角色已加载、没有任务及阻塞菜单的村庄保存");
    if(getSingleton("snow.SnowSaveService")?.call("isIdle")!==true || this.value("get_SaveState")!==1 || this.value("get_LastSaveResult")===1)
      throw new Error("原生保存服务忙，请等待当前保存完成");
  }
  private sameRequestOwner(p:SaveRequest):void {
    const now=readRecoveryOwner();
    if(now.character!==p.owner.character||now.slot!==p.owner.slot||now.process!==p.owner.process)throw new Error("保存期间角色或进程已变化");
  }
  private performRequest():void {
    const p=this.requested;if(!p?.armed)return;p.armed=false;
    try {
      if(clockSeconds()>p.deadline)throw new Error("等待原生保存入口超时，未执行");
      this.requireRequestScope();this.sameRequestOwner(p);
      const agent=createInstance("snow.SaveServiceUtility.SaveLoadAgent",true);
      if(!agent||agent.get_field("_State")!==0)throw new Error("原生保存 Agent 不可用");
      agent.add_ref();p.agent=agent;
      // The normal save menu uses the same false flag. This method allocates
      // the managed onRequestEnd delegate and retains its target agent.
      p.message="已请求原生保存，等待当前角色写入与完成回调";
      agent.call("requestSaveAll(System.Boolean)",false);
      this.callbacks.report("native-save-requested",{serial:p.serial,slot:p.owner.slot});
    }catch(error){p.status=p.agent?"uncertain":"rejected";p.message=String(error);this.callbacks.report("native-save-request-error",p.message);}
  }
  private sampleRequest():void {
    const p=this.requested;if(!p?.agent||p.status!=="queued")return;
    try {
      this.sameRequestOwner(p);
      const state=this.value("get_SaveState"),result=this.value("get_LastSaveResult");
      if(state!==1||result===1)p.seenBusy=true;
      if(p.seenBusy&&state===1&&result===2&&this.value("get_LastSaveFailed")===false&&this.value("get_SaveSlotLast")===p.owner.slot+1)p.characterSaved=true;
      const agentState=p.agent.get_field("_State");
      if(agentState===2){p.status="rejected";p.message="原生保存回调报告失败；恢复记录保留";}
      else if(agentState===3){
        const success=p.agent.call("takeResult")===true;
        p.status=success&&p.characterSaved?"applied":"uncertain";
        p.message=p.status==="applied"?"当前角色原生保存成功，角色写入与完成回调均已核验":"保存回调已结束，但缺少匹配角色的新写入证据；不自动重试";
      }
      if(p.status!=="queued")this.callbacks.report("native-save-result",{serial:p.serial,status:p.status,slot:p.owner.slot,characterSaved:p.characterSaved});
    }catch(error){p.status="uncertain";p.message=String(error);}
  }
  private value(name:string):unknown { return this.getters[name]!.call(null); }
  private sample():void {
    const p=this.pending;if (!p) return;
    try {
      const state=this.value("get_SaveState"),result=this.value("get_LastSaveResult");
      if (!Number.isInteger(state) || !Number.isInteger(result)) throw new Error("Native save state unreadable");
      if (state!==1 || result===1) p.seenBusy=true; // IDLE=1 / Doing=1, installed native enums.
      if (!p.seenBusy || state!==1 || result===1) return;
      if (result!==2 || this.value("get_LastSaveFailed")!==false) {
        this.pending=null;this.callbacks.report("recovery-save-failed",{result});return;
      }
      if (this.value("get_SaveSlotLast")!==p.owner.slot+1) return; // System save uses a different slot.
      const current=readRecoveryOwner();
      if (current.character!==p.owner.character || current.slot!==p.owner.slot || current.process!==p.owner.process)
        throw new Error("Character changed during native save");
      const snow=getSingleton("snow.SnowSaveService");
      if (![0,1,3].includes(snow?.get_field("_SnowSaveState") as number)) return;
      this.pending=null;this.completed=p;
    } catch(error) {this.pending=null;this.callbacks.report("recovery-save-blocked",String(error));}
  }
  /** Journal writes run on the regular Lua frame, outside native save callbacks. */
  tick():void {
    this.sampleRequest();
    const request=this.requested;
    if(request?.status==="queued"&&clockSeconds()>request.deadline){
      request.status=request.agent?"uncertain":"rejected";request.armed=false;
      request.message=request.agent?"原生保存等待超时，结果待核实；不会自动重复保存":"未等到原生保存更新，未执行保存";
    }
    const done=this.completed;if (!done) return;this.completed=null;
    try {this.callbacks.commit(done.token);this.callbacks.report("recovery-save-committed",{slot:done.owner.slot});}
    catch(error) {this.callbacks.report("recovery-save-blocked",String(error));}
  }
}
