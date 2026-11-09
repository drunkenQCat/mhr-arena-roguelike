import {createHash} from "node:crypto";
import {expect,it,vi} from "vitest";
import {validateConfig} from "../core/config";
import {defaultConfig} from "./default_config";
import {ConfigStore,CONFIG_FILE,CONFIG_PENDING_FILE,type ConfigStorage} from "./config_store";
vi.mock("./sdk",()=>({rejson:{dump_string:JSON.stringify,load_string:JSON.parse}}));
function fixture(){
 const files:Record<string,string>={};let fail="";
 const disk:ConfigStorage={read:file=>files[file]??null,write:(file,text)=>{if(file===fail)return false;files[file]=text;return true;},
  digest:text=>createHash("sha256").update(text).digest("hex")};
 const old=validateConfig(defaultConfig),next={...old,startPt:old.startPt+50};files[CONFIG_FILE]=JSON.stringify(old);
 return{files,disk,old,next,store:new ConfigStore(disk),fail:(file:string)=>{fail=file;}};
}
it("keeps old config until publish and keeps a rollback journal until global completion",()=>{
 const f=fixture();f.store.begin(f.old,f.next,"s/1");expect(JSON.parse(f.files[CONFIG_FILE]!).startPt).toBe(f.old.startPt);
 f.store.publish();expect(JSON.parse(f.files[CONFIG_FILE]!).startPt).toBe(f.next.startPt);expect(JSON.parse(f.files[CONFIG_PENDING_FILE]!).active).toBe(true);
 f.store.complete();expect(JSON.parse(f.files[CONFIG_PENDING_FILE]!).active).toBe(false);expect(new ConfigStore(f.disk).recover()).toBe(false);
});
it.each(["beforePublish","afterPublish"] as const)("recovers the exact old complete config after a reset %s",stage=>{
 const f=fixture();const original=f.files[CONFIG_FILE];f.store.begin(f.old,f.next,"s/2");if(stage==="afterPublish")f.store.publish();
 expect(new ConfigStore(f.disk).recover()).toBe(true);expect(f.files[CONFIG_FILE]).toBe(original);
 expect(JSON.parse(f.files[CONFIG_PENDING_FILE]!).active).toBe(false);
});
it("refuses to overwrite a pending transaction",()=>{
 const f=fixture();f.store.begin(f.old,f.next,"s/3");const journal=f.files[CONFIG_PENDING_FILE];
 expect(()=>new ConfigStore(f.disk).begin(f.old,f.next,"s/4")).toThrow("恢复待办");expect(f.files[CONFIG_PENDING_FILE]).toBe(journal);
});
it.each(["truncated","tampered"] as const)("blocks recovery for %s journals without touching config",mode=>{
 const f=fixture();f.store.begin(f.old,f.next,"s/5");const original=f.files[CONFIG_FILE];
 if(mode==="truncated")f.files[CONFIG_PENDING_FILE]="{";
 else{const r=JSON.parse(f.files[CONFIG_PENDING_FILE]!);r.previousText=r.nextText;f.files[CONFIG_PENDING_FILE]=JSON.stringify(r);}
 expect(()=>new ConfigStore(f.disk).recover()).toThrow();expect(f.files[CONFIG_FILE]).toBe(original);
});
it("retains the backup and stops on failed publication or rollback",()=>{
 const f=fixture();f.store.begin(f.old,f.next,"s/6");f.fail(CONFIG_FILE);
 expect(()=>f.store.publish()).toThrow("保存");expect(()=>f.store.rollback()).toThrow("保存");expect(JSON.parse(f.files[CONFIG_PENDING_FILE]!).active).toBe(true);
 f.fail("");expect(new ConfigStore(f.disk).recover()).toBe(true);
});
it("refuses retirement if another process replaced the journal or published config",()=>{
 const f=fixture();f.store.begin(f.old,f.next,"s/7");f.store.publish();f.files[CONFIG_FILE]="{}";expect(()=>f.store.complete()).toThrow("外部修改");
 const r=JSON.parse(f.files[CONFIG_PENDING_FILE]!);r.identity="stranger";f.files[CONFIG_PENDING_FILE]=JSON.stringify(r);expect(()=>f.store.rollback()).toThrow("被替换");
});
it("does not retire a backup when the final journal write fails",()=>{
 const f=fixture();f.store.begin(f.old,f.next,"s/8");f.store.publish();f.fail(CONFIG_PENDING_FILE);
 expect(()=>f.store.complete()).toThrow();expect(JSON.parse(f.files[CONFIG_PENDING_FILE]!).active).toBe(true);
 f.fail("");new ConfigStore(f.disk).recover();expect(JSON.parse(f.files[CONFIG_FILE]!).startPt).toBe(f.old.startPt);
});
