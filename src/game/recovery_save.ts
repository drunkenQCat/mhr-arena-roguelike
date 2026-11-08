import { findTypeDefinition, getSingleton, hookMethod, PRE_HOOK, type REMethodDefinition } from "./sdk";
import { readRecoveryOwner, type RecoveryOwner } from "./recovery_owner";

interface SaveCallbacks {
  prepare(): void;
  capture(): string | null;
  commit(token: string): void;
  report(event: string, detail: unknown): void;
}
interface Attempt { token: string; owner: RecoveryOwner; seenBusy: boolean }
const STORAGE="via.storage.saveService.SaveService";

/** Observe an engine-initiated CHARACTER save, including its fresh busy->success
 * transition. Never invokes a save API, alters a result, or certifies an old success. */
export class RecoverySave {
  private pending: Attempt | null=null;
  private completed: Attempt | null=null;
  private getters: Record<string,REMethodDefinition>={};
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
    hookMethod(update,()=>{this.sample();return PRE_HOOK.CALL_ORIGINAL;},value=>value);
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
    const done=this.completed;if (!done) return;this.completed=null;
    try {this.callbacks.commit(done.token);this.callbacks.report("recovery-save-committed",{slot:done.owner.slot});}
    catch(error) {this.callbacks.report("recovery-save-blocked",String(error));}
  }
}
