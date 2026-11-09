import {clockSeconds} from "./sdk";
import {ConfigStore} from "./config_store";

/** Retry an unfinished config rollback only after the native quest and personal
 * inventory recovery have ended. Failures block the next run, not that cleanup. */
export class ConfigRecovery {
  message:string|null=null;
  private lastPoll=-1;
  constructor(private readonly store:Pick<ConfigStore,"recover">=new ConfigStore()){}
  tick(safe:boolean):void {
    if(!safe||this.lastPoll===clockSeconds())return;
    this.lastPoll=clockSeconds();
    try{this.store.recover();this.message=null;}
    catch(e){this.message=`配置恢复待办：${String(e)}；暂不能开新局`;}
  }
}
