import {copyEffectValue} from './effect_contract';

export interface MailboxContext {lobby:string;owner:string;self:string;session:string;epoch:string;members:string[]}
export interface MailboxLobby {lobby:string;owner:string;self:string;ownerValue:string;members:{id:string;value:string}[]}
export interface MailboxPort<Q,R> {
 now():number;
 read():MailboxLobby|null;
 writeMember(value:string):boolean;
 writeOwner(value:string):boolean;
 encode(value:unknown):string;
 decode(value:string):unknown;
 bytes(value:string):number;
 fingerprint(value:unknown):string;
 /** Owner-only application handler. Must be durably idempotent itself; no
  * remote receipt or transport success is proof of a native delivery. */
 dispatch(sender:string,epoch:string,id:string,query:Q):R;
 fail(reason:string):void;
}
export type MailboxResult<R>={state:'waiting'}|{state:'reply';value:R}|{state:'uncertain';message:string};
interface Query<Q>{no:number;id:string;fingerprint:string;payload:Q}
interface Reply<R>{to:string;epoch:string;no:number;id:string;query:string;fingerprint:string;payload:R}
interface MemberFrame<Q>{v:1;s:string;e:string;n:number;h:number;ack:string|null;q:Query<Q>|null}
interface OwnerFrame<R>{v:1;s:string;e:string;n:number;r:Reply<R>|null}
interface Peer<Q,R>{epoch:string;counter:number;at:number;echo:number;ack:string|null;q:Query<Q>|null;
 lastNo:number;ackedNo:number;fingerprint:string;reply:Reply<R>|null}
interface LocalRequest<Q,R>{query:Query<Q>;started:number;result:MailboxResult<R>}
const integer=(v:unknown,min=0):v is number=>typeof v==='number'&&Number.isInteger(v)&&v>=min&&v<=9007199254740991;
const text=(v:unknown,max:number):v is string=>typeof v==='string'&&v.length>0&&v.length<=max&&!v.includes('|');
const hash=(v:unknown):v is string=>typeof v==='string'&&v.length===64&&v.split('').every(c=>'0123456789abcdef'.includes(c));

/** Acknowledged single-slot mailboxes over Steam metadata. Each client has one
 * outstanding request; the owner serializes replies until their exact digest
 * is acknowledged. The native member record supplies sender identity. */
export class PeerMailbox<Q,R> {
 private readonly host:boolean;
 private peers=new Map<string,Peer<Q,R>>();
 private local=new Map<string,LocalRequest<Q,R>>();
 private pending:LocalRequest<Q,R>|null=null;
 private localNo=0;private memberCounter=0;private ownerCounter=0;
 private lastHostCounter=0;private hostEpoch:string|null=null;private hostAt=-1;
 private active:Reply<R>|null=null;private queue:Reply<R>[]=[];
 private publications:{no:number;at:number}[]=[];
 private lastPoll=-1;private failure:string|null=null;private started:number;
 private observed=false;
 static readonly MAX_BYTES=2048;static readonly FRESH=15;static readonly REQUEST_TIMEOUT=45;static readonly SESSION_TIMEOUT=120;
 constructor(private readonly context:MailboxContext,private readonly port:MailboxPort<Q,R>){
  if(!text(context.lobby,20)||!text(context.owner,20)||!text(context.self,20)||!text(context.session,128)||!text(context.epoch,96)||
    context.members.length<2||context.members.length>4||new Set(context.members).size!==context.members.length||
    !context.members.includes(context.self)||!context.members.includes(context.owner)||context.members.some(m=>!text(m,20)))throw new Error('业务信箱身份非法');
  this.context=copyEffectValue(context);this.host=context.self===context.owner;this.started=port.now();
 }
 private digest(value:unknown):string{const valueHash=this.port.fingerprint(value);if(!hash(valueHash))throw new Error('业务信箱摘要不可用');return valueHash;}
 private encode(value:unknown):string{const text=this.port.encode(value);if(this.port.bytes(text)>PeerMailbox.MAX_BYTES)throw new Error('业务信箱超过2048字节，未提交');return text;}
 private fresh(peer:Peer<Q,R>):boolean{
  const now=this.port.now();if(now-peer.at>PeerMailbox.FRESH)return false;
  return !this.host||this.publications.some(p=>p.no===peer.echo&&now-p.at<=PeerMailbox.FRESH);
 }
 ready():boolean{return !this.failure&&this.hostEpoch!==null&&this.port.now()-this.hostAt<=PeerMailbox.FRESH&&
  this.context.members.every(id=>{const p=this.peers.get(id);return !!p&&this.fresh(p);});}
 busy():boolean{return !!this.pending||this.host&&(!!this.active||this.queue.length>0);}
 result(id:string):MailboxResult<R>|null{return this.local.has(id)?copyEffectValue(this.local.get(id)!.result):null;}
 request(id:string,payload:Q):number{
  if(this.failure)throw new Error(this.failure);
  if(!text(id,160))throw new Error('业务请求标识非法');
  const fingerprint=this.digest({id,payload}),existing=this.local.get(id);
  if(existing){if(existing.query.fingerprint!==fingerprint)throw new Error('业务请求标识已绑定其他载荷');return existing.query.no;}
  if(!this.ready())throw new Error('固定队员业务信箱尚未确认或已失去心跳');
  if(this.pending)throw new Error('上一笔业务请求尚未确认');
  if(this.local.size>=8192)throw new Error('本局业务请求达到上限，请安全结束本局');
  const query:Query<Q>={no:this.localNo+1,id,fingerprint,payload:copyEffectValue(payload)};
  // Size-check the complete envelope before it can become a published request.
  this.encode({v:1,s:this.context.session,e:this.context.epoch,n:this.memberCounter+1,h:this.lastHostCounter,ack:null,q:query});
  const request:LocalRequest<Q,R>={query,started:this.port.now(),result:{state:'waiting'}};
  this.localNo++;this.local.set(id,request);this.pending=request;return query.no;
 }
 private ack(reply:Reply<R>):string{return `${this.hostEpoch}|${reply.epoch}|${reply.no}|${reply.query}|${reply.fingerprint}`;}
 private parseMember(value:string):MemberFrame<Q>|null{
  if(value.length===0)return null;const raw=this.port.decode(value) as MemberFrame<Q>|null;
  if(!raw||raw.s!==this.context.session)return null;
  if(raw.v!==1||!text(raw.e,96)||!integer(raw.n,1)||!integer(raw.h)||raw.ack!=null&&typeof raw.ack!=='string')throw new Error('业务成员信箱格式不匹配');
  // REFramework's Lua JSON binding omits table fields whose value is nil.
  raw.ack=raw.ack??null;raw.q=raw.q??null;
  const q=raw.q;if(q!==null&&(!q||!integer(q.no,1)||!text(q.id,160)||!hash(q.fingerprint)||q.fingerprint!==this.digest({id:q.id,payload:q.payload})))throw new Error('业务请求序号或摘要不匹配');
  return raw;
 }
 private observeOwner(value:string):void{
  if(value.length===0)return;const raw=this.port.decode(value) as OwnerFrame<R>|null;
  if(!raw||raw.s!==this.context.session)return;
  if(raw.v!==1||!text(raw.e,96)||!integer(raw.n,1))throw new Error('房主业务信箱格式不匹配');
  if(this.hostEpoch!==null&&this.hostEpoch!==raw.e)throw new Error('房主业务脚本代号已更换，旧许可失效');
  this.hostEpoch=raw.e;
  if(raw.n<=this.lastHostCounter)return;
  this.lastHostCounter=raw.n;this.hostAt=this.port.now();
  const r=raw.r;if(r==null)return;
  if(!r||!this.context.members.includes(r.to)||!text(r.epoch,96)||!integer(r.no,1)||!text(r.id,160)||!hash(r.query)||!hash(r.fingerprint)||r.fingerprint!==this.digest(r.payload))throw new Error('房主回执身份或摘要不匹配');
  if(r.to!==this.context.self||r.epoch!==this.context.epoch)return;
  const own=this.local.get(r.id);
  if(!own||own.query.no!==r.no||own.query.fingerprint!==r.query)throw new Error('房主回执与本机请求不匹配');
  if(own.result.state==='uncertain')return;
  if(own.result.state==='reply'){
   if(this.digest(own.result.value)!==r.fingerprint)throw new Error('同一业务回执内容改变');
  }else{own.result={state:'reply',value:copyEffectValue(r.payload)};if(this.pending===own)this.pending=null;}
  this.lastAck=this.ack(r);
 }
 private lastAck:string|null=null;
 private observeMembers(lobby:MailboxLobby):void{
  for(const member of lobby.members){
   const frame=this.parseMember(member.value);if(!frame)continue;
   let peer=this.peers.get(member.id);
   if(member.id===this.context.self&&frame.e!==this.context.epoch||peer&&peer.epoch!==frame.e)throw new Error('业务队员脚本代号已更换，不能接收旧请求');
   if(!peer){peer={epoch:frame.e,counter:0,at:this.port.now(),echo:0,ack:null,q:null,lastNo:0,ackedNo:0,fingerprint:'',reply:null};this.peers.set(member.id,peer);}
   if(frame.n<=peer.counter)continue;
   peer.counter=frame.n;peer.at=this.port.now();peer.echo=frame.h;peer.ack=frame.ack;peer.q=frame.q;
  }
 }
 private ownerDispatch():void{
  if(this.active){const peer=this.peers.get(this.active.to);
   if(peer?.ack===this.ack(this.active)){peer.ackedNo=this.active.no;this.active=null;}}
  if(this.ready())for(const sender of this.context.members){
   const peer=this.peers.get(sender)!,query=peer.q;if(!query||!this.fresh(peer))continue;
   if(query.no<peer.lastNo)continue;
   if(query.no===peer.lastNo){
    if(query.fingerprint!==peer.fingerprint||query.id!==peer.reply?.id)throw new Error('相同成员业务序号载荷改变');
    continue; // The existing active/queued reply is retried, never dispatched twice.
   }
   if(peer.lastNo!==peer.ackedNo)continue;
   if(query.no!==peer.lastNo+1)throw new Error('成员业务请求序号跳跃');
   const payload=this.port.dispatch(sender,peer.epoch,query.id,copyEffectValue(query.payload));
   const reply:Reply<R>={to:sender,epoch:peer.epoch,no:query.no,id:query.id,query:query.fingerprint,fingerprint:this.digest(payload),payload:copyEffectValue(payload)};
   this.encode({v:1,s:this.context.session,e:this.context.epoch,n:this.ownerCounter+1,r:reply});
   peer.lastNo=query.no;peer.fingerprint=query.fingerprint;peer.reply=reply;this.queue.push(reply);
  }
  if(!this.active&&this.queue.length)this.active=this.queue.shift()!;
 }
 tick():void{
  if(this.failure)return;const now=this.port.now();if(now===this.lastPoll)return;this.lastPoll=now;
  try{
   const lobby=this.port.read();
   if(!lobby){if(this.observed||now-this.started>PeerMailbox.SESSION_TIMEOUT)throw new Error('固定业务房间已不可观察');return;}
   this.observed=true;
   {
    if(lobby.lobby!==this.context.lobby||lobby.owner!==this.context.owner||lobby.self!==this.context.self||
      lobby.members.map(m=>m.id).sort().join(',')!==[...this.context.members].sort().join(','))throw new Error('固定业务房间或名册已变化');
    if(this.port.bytes(lobby.ownerValue)>PeerMailbox.MAX_BYTES||lobby.members.some(m=>this.port.bytes(m.value)>PeerMailbox.MAX_BYTES))throw new Error('收到超大业务信箱');
    this.observeOwner(lobby.ownerValue);this.observeMembers(lobby);
    if(this.host)this.ownerDispatch();
   }
   if(this.pending&&now-this.pending.started>=PeerMailbox.REQUEST_TIMEOUT)throw new Error('业务回执超时，结果待核实；禁止自动重发');
   if(!this.ready()&&now-this.started>PeerMailbox.SESSION_TIMEOUT)throw new Error('固定业务队员超过120秒未确认');
   const q=this.pending?.query??null;
   const member:MemberFrame<Q>={v:1,s:this.context.session,e:this.context.epoch,n:++this.memberCounter,h:this.lastHostCounter,ack:this.lastAck,q};
   if(!this.port.writeMember(this.encode(member)))throw new Error('成员业务信箱提交失败，不能假定已送达');
   if(this.host){
    const frame:OwnerFrame<R>={v:1,s:this.context.session,e:this.context.epoch,n:++this.ownerCounter,r:this.active};
    if(!this.port.writeOwner(this.encode(frame)))throw new Error('房主业务信箱提交失败，不能假定已送达');
    this.publications.push({no:frame.n,at:now});if(this.publications.length>64)this.publications.shift();
   }
  }catch(e){this.close(String(e));}
 }
 close(reason:string):void{
  if(this.failure)return;this.failure=reason;
  if(this.pending){this.pending.result={state:'uncertain',message:reason};this.pending=null;}
  try{this.port.fail(reason);}catch{/* The transport stays fenced even if shutdown diagnostics fail. */}
 }
 snapshot(){return {ready:this.ready(),busy:this.busy(),failure:this.failure,pending:this.pending?.query.id??null,
  hostEpoch:this.hostEpoch,peers:this.context.members.map(id=>({id,fresh:!!this.peers.get(id)&&this.fresh(this.peers.get(id)!)}))};}
}
