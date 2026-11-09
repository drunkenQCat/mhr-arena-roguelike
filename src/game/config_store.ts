/** Durable local half of the multiplayer config transaction. An unfinished
 * proposal always restores its previous complete config on the next Lua boot.
 * Never reuse the equipment/pouch recovery filenames for planner settings. */
import {validateConfig,type RogueConfig} from "../core/config";
import {loadWebconsole,refFs,rejson} from "./sdk";
export const CONFIG_FILE="mhw_rogue_config.json";
export const CONFIG_PENDING_FILE="mhw_rogue_config_pending.json";
interface RecordState {version:1;active:boolean;identity?:string;previousText?:string;previousHash?:string;nextText?:string;nextHash?:string}
export interface ConfigStorage {
  read(file:string):string|null;
  write(file:string,text:string):boolean;
  digest(text:string):string;
}
export function serializeConfig(config:RogueConfig):string {
  return rejson.dump_string(config,-1).split('"unlockChain":null').join('"unlockChain":[]')
    .split('"weak":null').join('"weak":[]');
}
function nativeStorage():ConfigStorage {
  return {
    read:(file)=>{
      const text=refFs.read(file);
      if(text===""&&!refFs.glob(file.split(".").join("\\.")).includes(file))return null;
      return text;
    },
    write:(file,text)=>{
      const native=loadWebconsole();
      if(!native.write_config)throw new Error("配置原子保存需要新版 webconsole DLL，请完整更新并重启游戏");
      return native.write_config(file,text);
    },
    digest:text=>loadWebconsole().steam_digest?.(text)??"",
  };
}
function isHash(text:unknown):text is string{return typeof text==="string"&&text.length===64&&text.split("").every(c=>"0123456789abcdef".includes(c));}
export class ConfigStore {
  private record:RecordState|null=null;
  constructor(private readonly disk:ConfigStorage=nativeStorage()){}
  private write(file:string,text:string):void {
    if(!this.disk.write(file,text)||this.disk.read(file)!==text)throw new Error(`配置保存或读回失败：${file}；保留恢复记录`);
  }
  private digest(text:string):string {
    const hash=this.disk.digest(text);if(!isHash(hash))throw new Error("配置保存摘要不可用");return hash;
  }
  private read():RecordState|null {
    const text=this.disk.read(CONFIG_PENDING_FILE);if(text===null)return null;
    let record:RecordState;
    try{record=rejson.load_string(text) as RecordState;}catch{throw new Error("配置恢复记录损坏，保留文件并停止开局");}
    if(!record||record.version!==1||typeof record.active!=="boolean")throw new Error("配置恢复记录格式未知，保留文件并停止开局");
    if(record.active) {
      if(typeof record.identity!=="string"||record.identity.length<1||record.identity.length>256||
        typeof record.previousText!=="string"||typeof record.nextText!=="string"||
        !isHash(record.previousHash)||!isHash(record.nextHash)||
        this.digest(record.previousText)!==record.previousHash||this.digest(record.nextText)!==record.nextHash)
        throw new Error("配置恢复记录摘要或身份非法，保留文件并停止开局");
      validateConfig(rejson.load_string(record.previousText));validateConfig(rejson.load_string(record.nextText));
    }
    return record;
  }
  begin(previous:RogueConfig,next:RogueConfig,identity:string):void {
    if(this.record||this.read()?.active)throw new Error("上一份配置仍有恢复待办，不能覆盖备份");
    if(identity.length<1||identity.length>256)throw new Error("配置事务身份非法");
    const previousText=serializeConfig(validateConfig(previous)),nextText=serializeConfig(validateConfig(next));
    const record:RecordState={version:1,active:true,identity,previousText,nextText,
      previousHash:this.digest(previousText),nextHash:this.digest(nextText)};
    this.write(CONFIG_PENDING_FILE,rejson.dump_string(record,-1));this.record=record;
  }
  publish():void {
    const r=this.requireCurrent();this.write(CONFIG_FILE,r.nextText!);
    // Keep the previous config until ALL peers have acknowledged persistence.
  }
  complete():void {
    const r=this.requireCurrent();
    if(this.disk.read(CONFIG_FILE)!==r.nextText)throw new Error("已发布配置被外部修改，不能确认完成");
    this.write(CONFIG_PENDING_FILE,rejson.dump_string({version:1,active:false},-1));this.record=null;
  }
  rollback():void {
    const r=this.requireCurrent();this.write(CONFIG_FILE,r.previousText!);
    this.write(CONFIG_PENDING_FILE,rejson.dump_string({version:1,active:false},-1));this.record=null;
  }
  /** Call before loading overrides; callers must not swallow this error and
   * silently start from defaults while a journal remains unresolved. */
  recover():boolean {
    const r=this.read();if(!r?.active)return false;this.record=r;this.rollback();return true;
  }
  private requireCurrent():RecordState {
    const r=this.record;if(!r?.active)throw new Error("没有活动配置事务");
    const observed=this.read();
    if(!observed?.active||observed.identity!==r.identity||observed.previousHash!==r.previousHash||observed.nextHash!==r.nextHash)
      throw new Error("配置恢复记录被替换，禁止覆盖");
    return r;
  }
}
