/** Bounded, independent configuration barrier. Callers own schema validation,
 * persistence/recovery and applying effective run rules. Steam submission is
 * never treated as peer delivery. No gameplay plan/ACK keys are overwritten. */
import { clockSeconds, rejson, type NativeWebconsole } from "./sdk";
import { canonical } from "./wire_canonical";

export interface ConfigContext { lobby:string; owner:string; self:string; session:string; members:string[] }
export interface ConfigBoundary { token:number; layer:number; ready:boolean }
export interface ConfigCandidate<T> { value:T; effectiveHash:string }
export interface ConfigHooks<T> {
  boundary():ConfigBoundary;
  currentHash():string;
  /** Pure validation: no equipment, inventory, wallet or disk mutations. */
  validate(payload:string):ConfigCandidate<T>;
  /** Provisional apply; restore() must undo it after any failed commit. */
  apply(value:T):void;
  /** All fixed peers have applied. Persist using the caller's durable protocol. */
  finish(value:T):void;
  /** Retire local rollback journal only after global durable completion. */
  complete?():void;
  restore():void;
  /** Stops the whole run when a partially applied commit cannot complete. */
  fail(reason:string):void;
}
type Phase="prepare"|"commit"|"release"|"done"|"cancel"|"abort";
interface Control {
  v:1; session:string; owner:string; lobby:string; serial:number;
  token:number; layer:number; oldHash:string; newHash:string; payloadHash:string; phase:Phase;
}
interface Ack { v:1; identity:string; status:"ready"|"applied"|"released"|"cancelled"|"rejected"; reason?:string }
interface Pending<T> { control:Control; identity:string; started:number; candidate:ConfigCandidate<T>|null;
  applied:boolean; finished:boolean; status:Ack["status"]|null; reason:string; }
export interface ConfigResult { serial:number; status:"applied"|"rejected"; message:string }
type Lobby=NonNullable<NativeWebconsole["steam_snapshot"]> extends (...args:never[])=>infer R
  ? R extends {lobbies:(infer L)[]} ? L : never : never;
const hash=(s:unknown):s is string=>typeof s==="string"&&s.length===64&&s.split("").every(c=>"0123456789abcdef".includes(c));
const phaseRank=(p:Phase)=>p==="prepare"?1:p==="commit"?2:p==="release"?3:4;
function identity(c:Control):string {
  return canonical([c.session,c.owner,c.lobby,c.serial,c.token,c.layer,c.oldHash,c.newHash,c.payloadHash]);
}

export class MultiplayerConfig<T> {
  private serial=0;
  private lastClosed=0;
  private pending:Pending<T>|null=null;
  private terminal:ConfigResult|null=null;
  private lastPoll=-1;
  private stopped=false;
  private message="波间集结且交易完成后，由房主提交配置";
  private readonly host:boolean;
  static readonly TIMEOUT=45;
  constructor(private readonly context:ConfigContext,private readonly hooks:ConfigHooks<T>,
    private readonly network:NativeWebconsole) {
    this.context={...context,members:[...context.members]};
    this.host=context.self===context.owner;
    if(context.members.length<2||context.members.length>4||new Set(context.members).size!==context.members.length||
      !context.members.includes(context.self)||!context.members.includes(context.owner))throw new Error("Invalid config roster");
    if([context.lobby,context.owner,context.self,context.session,...context.members].some(s=>typeof s!=="string"||s.length<1||s.length>96))
      throw new Error("Invalid config identity");
    if(!network.steam_config_payload||!network.steam_config_control||!network.steam_config_ack||!network.steam_digest)
      throw new Error("联机配置同步需要新版 webconsole DLL，请重启游戏后重试");
  }
  busy():boolean{return this.pending!==null;}
  result(serial:number):ConfigResult|null{return this.terminal?.serial===serial?{...this.terminal}:null;}
  private digest(text:string):string {
    const digest=this.network.steam_digest!(text);
    if(!hash(digest))throw new Error("配置摘要不可用");
    return digest;
  }
  private lobby():Lobby {
    const l=this.network.steam_snapshot?.()?.lobbies.find(l=>l.id===this.context.lobby&&l.self===this.context.self&&l.owner===this.context.owner);
    if(!l||l.members.map(m=>m.id).sort().join(",")!==[...this.context.members].sort().join(","))
      throw new Error("配置同步期间固定队伍或房主改变");
    return l;
  }
  propose(payload:string):number {
    if(!this.host||this.stopped)throw new Error("仅当前房主可以提出配置");
    if(this.pending)throw new Error("上一份联机配置尚未完成");
    const b=this.hooks.boundary();
    if(!b.ready||!Number.isInteger(b.token)||b.token<0||!Number.isInteger(b.layer)||b.layer<1)throw new Error("请先完成清波、全员集结和未决交易");
    this.lobby();
    const candidate=this.hooks.validate(payload),oldHash=this.hooks.currentHash();
    if(!hash(candidate.effectiveHash)||!hash(oldHash))throw new Error("有效配置摘要非法");
    // Native payload byte bound is authoritative (Lua length is bytes, JS is UTF16).
    const control:Control={v:1,session:this.context.session,owner:this.context.owner,lobby:this.context.lobby,
      serial:++this.serial,token:b.token,layer:b.layer,oldHash,newHash:candidate.effectiveHash,payloadHash:this.digest(payload),phase:"prepare"};
    this.pending={control,identity:identity(control),candidate,started:clockSeconds(),applied:false,finished:false,status:"ready",reason:""};
    this.message="已冻结交易与选波，等待全队校验配置";
    try {
      if(!this.network.steam_config_payload!(this.context.lobby,payload))throw new Error("Steam 未接受完整配置，请缩小到 64 KB 内并重试");
      this.publish();
    }catch(e){this.change("cancel",String(e));}
    return control.serial;
  }
  cancel():void {
    if(!this.host||!this.pending)throw new Error("没有可取消的房主提案");
    if(this.pending.control.phase!=="prepare")throw new Error("配置已开始提交，不能单端取消");
    this.change("cancel","房主取消配置提案");
  }
  shutdown(reason:string):void {if(this.pending&&!this.stopped)this.fatal(reason);}
  private change(phase:Phase,reason=""):void {
    const p=this.pending!;p.control={...p.control,phase};p.started=clockSeconds();p.reason=reason;
  }
  private publish():void {
    const p=this.pending!;
    if(this.host&&!this.network.steam_config_control!(this.context.lobby,rejson.dump_string(p.control,-1)))
      throw new Error("配置控制帧发送失败");
    if(p.status) {
      const ack:Ack={v:1,identity:p.identity,status:p.status};
      // Lua slices bytes, JS slices UTF16. Keep wire errors short and ASCII;
      // the full local cause remains in snapshot/result for the support log.
      if(p.reason!=="")ack.reason="Peer configuration validation/persistence failed; inspect that peer's support log";
      if(!this.network.steam_config_ack!(this.context.lobby,rejson.dump_string(ack,-1)))throw new Error("配置确认发送失败");
    }
  }
  private parse(text:string):Control|null {
    let c:Control;
    try{c=rejson.load_string(text) as Control;}catch{return null;}
    if(!c||c.v!==1||c.session!==this.context.session)return null; // previous native session
    if(c.owner!==this.context.owner||c.lobby!==this.context.lobby||!Number.isInteger(c.serial)||c.serial<1||
      !Number.isInteger(c.token)||c.token<0||!Number.isInteger(c.layer)||c.layer<1||
      !hash(c.oldHash)||!hash(c.newHash)||!hash(c.payloadHash)||!["prepare","commit","release","done","cancel","abort"].includes(c.phase))
      throw new Error("配置控制帧身份或字段非法");
    return c;
  }
  private ack(lobby:Lobby,id:string):Ack|null {
    const p=this.pending!;
    if(id===this.context.self)return p.status?{v:1,identity:p.identity,status:p.status,reason:p.reason}:null;
    try {
      const a=rejson.load_string(lobby.members.find(m=>m.id===id)?.configAck??"") as Ack;
      return a?.v===1&&a.identity===p.identity&&["ready","applied","released","cancelled","rejected"].includes(a.status)?a:null;
    }catch{return null;}
  }
  private close(status:ConfigResult["status"],message:string):void {
    const p=this.pending!;
    this.lastClosed=p.control.serial;this.terminal={serial:p.control.serial,status,message};
    this.message=message;this.pending=null;
  }
  private fatal(reason:string):void {
    const p=this.pending;
    if(p?.applied)try{this.hooks.restore();}catch(e){reason+=`；旧配置恢复失败：${String(e)}`;}
    if(p){p.status="rejected";p.reason=reason;if(this.host)this.change("abort",reason);try{this.publish();}catch{/* native lobby may be gone */}
      this.close("rejected",reason);}
    this.stopped=true;this.hooks.fail(reason);
  }
  /** A commit can arrive before some prepare chunks; no validation, no ACK. */
  private receive(lobby:Lobby,c:Control):void {
    if(c.serial<=this.lastClosed)return;
    let p=this.pending;
    if(p&&c.serial!==p.control.serial)throw new Error("未完成配置被另一提案覆盖");
    if(p&&identity(c)!==p.identity)throw new Error("同一提案的配置或波次身份改变");
    if(!p) {
      if(c.phase!=="prepare"&&c.phase!=="cancel"&&c.phase!=="abort")throw new Error("未校验的配置不能直接提交");
      p={control:c,identity:identity(c),started:clockSeconds(),candidate:null,applied:false,finished:false,status:null,reason:""};this.pending=p;
    }
    if(phaseRank(c.phase)<phaseRank(p.control.phase))return; // delayed cached prepare
    if(c.phase!==p.control.phase)p.started=clockSeconds();
    p.control=c;
    if(c.phase==="abort")throw new Error("房主中止了配置提交");
    if(c.phase==="done") {
      if(!p.finished)throw new Error("配置尚未持久化，不能解除全队屏障");
      return;
    }
    if(c.phase==="cancel") {
      if(p.applied)throw new Error("已提交的配置收到非法取消");
      p.status="cancelled";return;
    }
    if(p.status==="rejected")return;
    const b=this.hooks.boundary();
    if(b.token!==c.token||b.layer!==c.layer||(!p.applied&&this.hooks.currentHash()!==c.oldHash))throw new Error("配置提案不属于当前波间边界");
    if(!p.candidate) {
      if(!b.ready)return; // in-flight local transaction must settle before READY
      if(!lobby.config?.complete||lobby.config.digest!==c.payloadHash)return;
      try {
        if(this.digest(lobby.config.payload)!==c.payloadHash)throw new Error("配置载荷摘要不同");
        p.candidate=this.hooks.validate(lobby.config.payload);
        if(p.candidate.effectiveHash!==c.newHash)throw new Error("全队有效配置摘要不同");
        p.status="ready";
      }catch(e){p.reason=String(e);p.status="rejected";return;}
    }
    if(c.phase==="commit"||c.phase==="release") {
      // A previously ready peer must not start a new transaction during the barrier.
      if(!b.ready)throw new Error("提交时仍有本地交易或波次状态改变");
      if(!p.applied){p.applied=true;this.hooks.apply(p.candidate.value);}
      p.status="applied";
    }
    if(c.phase==="release") {
      if(!p.finished){this.hooks.finish(p.candidate.value);p.finished=true;}
      p.status="released";
    }
  }
  tick():void {
    if(this.stopped||this.lastPoll===clockSeconds())return;this.lastPoll=clockSeconds();
    try {
      const previous=this.pending;
      if(previous&&clockSeconds()-previous.started>MultiplayerConfig.TIMEOUT) {
        // Check before reading late ACKs; a cached ACK arriving after its peer's
        // deadline must never revive an expired prepare/commit.
        if(this.host&&previous.control.phase==="prepare")this.change("cancel","队友配置校验超时，旧规则保留");
        else if(!this.host&&previous.control.phase==="prepare"&&previous.status!=="rejected") {
          previous.status="rejected";previous.reason="本机配置校验超时，拒绝后续提交";previous.started=clockSeconds();
        }else throw new Error("配置屏障超过45秒未完成，停止本局防止规则不一致");
      }
      const lobby=this.lobby();
      if(!this.host) {
        const c=this.parse(lobby.config?.control??"");
        if(c)this.receive(lobby,c);
      }
      const p=this.pending;if(!p)return;
      if(this.host) {
        const b=this.hooks.boundary();
        if(b.token!==p.control.token||b.layer!==p.control.layer)throw new Error("房主配置波间边界改变");
        if(p.control.phase==="prepare"&&(!b.ready||this.hooks.currentHash()!==p.control.oldHash))
          this.change("cancel","等待期间房主状态改变，旧规则保留");
        // Do not map missing ACKs into an array. null becomes nil in Lua;
        // holes can shorten #array and make ArrayEvery skip absent peers.
        const all=(status:Ack["status"])=>this.context.members.every(id=>this.ack(lobby,id)?.status===status);
        let rejected:Ack|null=null;
        for(const id of this.context.members) {
          const ack=this.ack(lobby,id);if(ack?.status==="rejected"){rejected=ack;break;}
        }
        if(rejected&&p.control.phase!=="cancel") {
          if(p.control.phase!=="prepare")throw new Error(rejected.reason??"队友配置提交失败");
          this.change("cancel",rejected.reason??"队友拒绝配置");
        }
        if(p.control.phase==="prepare"&&all("ready"))this.change("commit");
        if(p.control.phase==="commit") {
          if(!this.hooks.boundary().ready)throw new Error("房主提交边界改变");
          if(!p.applied){p.applied=true;this.hooks.apply(p.candidate!.value);}p.status="applied";
          if(all("applied"))this.change("release");
        }
        if(p.control.phase==="release") {
          if(!p.finished){this.hooks.finish(p.candidate!.value);p.finished=true;}p.status="released";
          if(all("released")){this.change("done");this.publish();this.hooks.complete?.();this.close("applied","全队已应用配置；当前波次与个人账本保留");return;}
        }
        if(p.control.phase==="cancel") {
          p.status="cancelled";
          if(all("cancelled")){this.publish();this.close("rejected",p.reason||"配置提案已取消");return;}
        }
      }
      this.publish();
      // Do not unlock on RELEASE: another peer's persistence can still fail.
      // DONE proves that every fixed peer has acknowledged durable completion.
      if(!this.host&&(p.control.phase==="done"||p.control.phase==="cancel")) {
        if(p.finished)this.hooks.complete?.();
        this.close(p.finished?"applied":"rejected",p.finished?"房主配置已确认生效":p.reason!==""?p.reason:"房主取消了配置提案");
      }
    }catch(e){this.fatal(String(e));}
  }
  snapshot():Record<string,unknown>{return{busy:this.busy(),host:this.host,message:this.pending?
    this.pending.control.phase==="prepare"?"正在等待全队校验配置":this.pending.control.phase==="commit"?"正在等待全队应用规则":
    this.pending.control.phase==="release"?"正在等待全队保存配置":this.pending.control.phase==="cancel"?"正在取消提案，保留旧规则":
    "正在确认配置事务完成":this.message,
    serial:this.pending?.control.serial??this.terminal?.serial??null,phase:this.pending?.control.phase??null,
    result:this.terminal?{...this.terminal}:null};}
}
