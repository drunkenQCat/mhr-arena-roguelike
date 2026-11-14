import {EffectOrders,type EffectContext,type EffectOrder,type OrderState} from './effect_orders';
import {copyEffectValue,validateEffectDefinition,validateEffectProduct,type EffectOffer,type EffectPhase,type Verification} from './effect_contract';

export interface EffectRoom {lobby:string;owner:string;session:string;members:string[]}
export interface EffectBoundary {layer:number;token:number;phase:EffectPhase;accepting:boolean}
export interface EffectBuyIntent {session:string;epoch:string;id:string;product:string;revision:string;layer:number;token:number;weapon:number;balance:number}
export interface EffectCancelIntent {session:string;epoch:string;id:string;order:string;layer:number;token:number}
export type AuthorityState=OrderState|'permitted'|'cancelPending';
export interface EffectCommitment {
 id:string;buyer:string;epoch:string;permit:number;context:EffectContext;offer:EffectOffer;
 state:AuthorityState;charged:boolean;nativeOrder:string;receiptSerial:number;receiptFingerprint:string;
 message:string;
}
interface Decision {key:string;fingerprint:string;ok:boolean;order:string|null;message:string}
export interface EffectAuthoritySnapshot {schema:1;room:EffectRoom;peers:Record<string,string>;orders:EffectCommitment[];
 decisions:Decision[];serial:number;locked:number[];released:number[];ready:Record<string,string>;closed:boolean;reason:string}
export interface AuthorityResult {ok:boolean;message:string;duplicate?:boolean;order?:EffectCommitment}
export interface EffectPeerReceipt {session:string;epoch:string;order:string;serial:number;state:OrderState;charged:boolean;
 revision:string;nativeOrder:string;verification:Verification;status:'applied'|'not-applied'|'unknown';evidence:string;message:string}
export interface EffectAuthorityPort {
 boundary():EffectBoundary;
 offer(id:string):EffectOffer;
 fingerprint(value:unknown):string;
 persist(snapshot:EffectAuthoritySnapshot):void;
}
const text=(v:unknown,max=160):v is string=>typeof v==='string'&&v.length>0&&v.length<=max&&!v.includes('|');
const integer=(v:unknown,min=0,max=9007199254740991):v is number=>typeof v==='number'&&Number.isInteger(v)&&v>=min&&v<=max;
const knownStates:OrderState[]=['reserved','locked','applying','active','suspended','cleaning','ended','cancelled','failed','uncertain','recovery','retired'];
const transitions:Record<AuthorityState,OrderState[]>={
 permitted:['reserved','applying','active','ended','cancelled','failed','uncertain','recovery','retired'],
 reserved:['reserved','locked','applying','active','ended','cancelled','failed','uncertain','recovery','retired'],
 cancelPending:['reserved','cancelled','failed','uncertain','recovery','retired'],
 locked:['locked','applying','active','ended','cancelled','failed','uncertain','recovery','retired'],
 applying:['applying','active','ended','failed','uncertain','recovery','retired'],
 active:['active','applying','suspended','cleaning','ended','recovery','retired'],
 suspended:['suspended','applying','active','cleaning','ended','recovery','retired'],
 cleaning:['cleaning','ended','recovery','retired'],
 uncertain:['uncertain','active','ended','failed','recovery','retired'],
 recovery:['recovery','active','cleaning','ended','retired'],
 failed:['failed','cancelled'],cancelled:['cancelled'],ended:['ended'],retired:['retired'],
};
const verified=(actual:Verification,required:Verification)=>['registration','attribute','combat'].indexOf(actual)>=['registration','attribute','combat'].indexOf(required);

/** Host-side quota/permit authority. It never modifies another player's native
 * objects or wallet. The buyer still reserves, executes and verifies locally;
 * this ledger serializes team limits and fences those signed peer receipts.
 * Persist MUST complete before publishing any returned permit. */
export class EffectAuthority {
 private state:EffectAuthoritySnapshot;
 private fatalReason:string|null=null;
 constructor(room:EffectRoom,private readonly port:EffectAuthorityPort,recovered?:EffectAuthoritySnapshot){
  if(!text(room.lobby,20)||!text(room.owner,20)||!text(room.session,128)||room.members.length<2||room.members.length>4||
    new Set(room.members).size!==room.members.length||!room.members.includes(room.owner)||room.members.some(m=>!text(m,20)))throw new Error('效果房间身份非法');
  this.state={schema:1,room:copyEffectValue(room),peers:{},orders:[],decisions:[],serial:0,locked:[],released:[],ready:{},closed:false,reason:''};
  if(recovered){
   if(recovered.schema!==1||this.digest(recovered.room)!==this.digest(room))throw new Error('效果授权恢复记录不属于当前房间');
   this.state=copyEffectValue(recovered);this.state.closed=true;this.state.reason='恢复记录只供核实，不能重放旧许可；请安全结束原局';
  }
 }
 snapshot():EffectAuthoritySnapshot{return copyEffectValue({...this.state,closed:this.state.closed||this.fatalReason!==null,reason:this.fatalReason??this.state.reason});}
 private digest(value:unknown):string{
  const hash=this.port.fingerprint(value);
  if(typeof hash!=='string'||hash.length!==64||hash.split('').some(c=>!'0123456789abcdef'.includes(c)))throw new Error('效果授权摘要不可用');
  return hash;
 }
 private mutate<T>(action:()=>T):T{
  const before=this.snapshot();
  let result:T;
  try{result=action();}catch(e){this.state=before;throw e;}
  try{this.port.persist(this.snapshot());return result;}
  catch(e){
   // A failed write/readback can already have published the new journal. Do
   // not roll back the durable possibility and grant its last slot again.
   this.state=before;this.fatalReason=this.fatalReason??`效果授权记录写入结果不明，已停止新许可：${String(e)}`;
   throw e;
  }
 }
 private live():void{if(this.fatalReason||this.state.closed)throw new Error(this.fatalReason??(this.state.reason||'效果房间已关闭'));}
 registerPeer(sender:string,epoch:string):void{
  this.live();if(!this.state.room.members.includes(sender)||!text(epoch,96))throw new Error('效果队员身份非法');
  const old=this.state.peers[sender];
  if(old&&old!==epoch){this.close('效果队员脚本或进程已更换；原许可失效，请安全结束本局');throw new Error(this.state.reason);}
  if(!old)this.mutate(()=>{this.state.peers[sender]=epoch;});
 }
 private peer(sender:string,session:string,epoch:string):void{
  this.live();if(session!==this.state.room.session||!this.state.room.members.includes(sender)||this.state.peers[sender]!==epoch)
   throw new Error('效果房间、队员或脚本代号已变化');
 }
 private boundary(layer:number,token:number):EffectBoundary{
  const b=this.port.boundary();if(!integer(layer,1)||!integer(token)||layer!==b.layer||token!==b.token)throw new Error('效果请求波次已过期');return b;
 }
 private key(sender:string,epoch:string,id:string):string{if(!text(id))throw new Error('效果请求标识非法');return `${this.state.room.session}|${sender}|${epoch}|${id}`;}
 private replay(key:string,fingerprint:string):AuthorityResult|null{
  const d=this.state.decisions.find(d=>d.key===key);if(!d)return null;
  if(d.fingerprint!==fingerprint)return {ok:false,message:'请求标识已绑定其他效果操作'};
  const order=d.order?this.state.orders.find(o=>o.id===d.order):undefined;
  return {ok:d.ok,message:d.message,duplicate:true,...(order?{order:copyEffectValue(order)}:{})};
 }
 private remember(key:string,fingerprint:string,result:AuthorityResult):AuthorityResult{
  this.state.decisions.push({key,fingerprint,ok:result.ok,order:result.order?.id??null,message:result.message});return result;
 }
 private availableDecision():void{if(this.state.decisions.length>=4096)throw new Error('效果操作记录达到上限，请安全结束本局');}
 private projections():EffectOrder[]{return this.state.orders.map(o=>({id:o.id,requestId:o.id,context:copyEffectValue(o.context),offer:copyEffectValue(o.offer),
  state:o.state==='permitted'||o.state==='cancelPending'?'reserved':o.state,charged:o.charged,message:o.message}));}
 authorizeBuy(sender:string,intent:EffectBuyIntent):AuthorityResult{
  this.peer(sender,intent.session,intent.epoch);const b=this.boundary(intent.layer,intent.token);
  if(!text(intent.product,128)||!text(intent.revision,128)||!integer(intent.balance,0,2147483647)||!integer(intent.weapon,0,13))throw new Error('效果购买载荷非法');
  const key=this.key(sender,intent.epoch,intent.id),fingerprint=this.digest({kind:'buy',intent});
  const replay=this.replay(key,fingerprint);if(replay)return replay;
  this.availableDecision();
  return this.mutate(()=>{
   const deny=(message:string)=>this.remember(key,fingerprint,{ok:false,message});
   if(!b.accepting||this.state.locked.includes(b.layer)&&b.phase!=='Carve')return deny('本波准备已锁定，不能接受新购买');
   if(b.phase==='Carve'&&!this.state.released.includes(b.layer))return deny('本波尚未完整开战，不能提前在剥取阶段购物');
   if(this.state.orders.length>=2048)return deny('效果授权记录达到上限，请安全结束本局');
   let offer:EffectOffer;
   try{offer=this.port.offer(intent.product);validateEffectDefinition(offer.definition);validateEffectProduct(offer,offer.definition,offer.groupRule);}
   catch(e){return deny(String(e));}
   if(offer.revision!==intent.revision)return deny('商品价格、效果参数或实现已变化，请查看新报价');
   if(offer.definition.delivery==='nextWave'&&this.state.locked.includes(b.layer))return deny('本波已锁定，不能在剥取阶段预订已经开打的强化');
   const context:EffectContext={run:this.state.room.session,wave:`${this.state.room.session}/wave-${b.layer}`,layer:b.layer,
    player:sender,team:[...this.state.room.members],phase:b.phase,weapon:intent.weapon};
   const forbidden=()=>{throw new Error('效果授权阶段禁止执行、扣款或清理');};
   const check=new EffectOrders({balance:()=>intent.balance,charge:forbidden,apply:forbidden,inspect:forbidden,remove:forbidden,persist:forbidden,
    check:()=>null,fingerprint:value=>this.digest(value)},this.projections());
   const reason=check.check(offer,context);if(reason)return deny(reason);
   const order:EffectCommitment={id:key,buyer:sender,epoch:intent.epoch,permit:++this.state.serial,context,offer:copyEffectValue(offer),state:'permitted',charged:false,
    nativeOrder:`${context.run}|${sender}|${intent.id}`,receiptSerial:0,receiptFingerprint:'',message:'房主已预占名额；等待购买者本机预留或交付核验'};
   this.state.orders.push(order);return this.remember(key,fingerprint,{ok:true,message:order.message,order:copyEffectValue(order)});
  });
 }
 authorizeCancel(sender:string,intent:EffectCancelIntent):AuthorityResult{
  this.peer(sender,intent.session,intent.epoch);const b=this.boundary(intent.layer,intent.token);
  const key=this.key(sender,intent.epoch,intent.id),fingerprint=this.digest({kind:'cancel',intent});
  const replay=this.replay(key,fingerprint);if(replay)return replay;this.availableDecision();
  return this.mutate(()=>{
   const deny=(message:string)=>this.remember(key,fingerprint,{ok:false,message});
   const order=this.state.orders.find(o=>o.id===intent.order&&o.buyer===sender&&o.epoch===intent.epoch);
   if(!order)return deny('没有本队员的效果订单');
   if(!b.accepting||this.state.locked.includes(order.context.layer)||order.state!=='reserved'||order.charged)return deny('订单已锁定或尚未确认可取消，不能释放名额');
   order.state='cancelPending';order.message='等待购买者本机取消确认；名额仍占用';order.permit=++this.state.serial;
   return this.remember(key,fingerprint,{ok:true,message:order.message,order:copyEffectValue(order)});
  });
 }
 report(sender:string,receipt:EffectPeerReceipt):AuthorityResult{
  this.peer(sender,receipt.session,receipt.epoch);
  const order=this.state.orders.find(o=>o.id===receipt.order&&o.buyer===sender&&o.epoch===receipt.epoch);
  if(!order)throw new Error('队员不能确认他人的效果订单');
  if(!integer(receipt.serial,1)||!knownStates.includes(receipt.state)||typeof receipt.charged!=='boolean'||
    receipt.nativeOrder!==order.nativeOrder||receipt.revision!==order.offer.revision||typeof receipt.message!=='string'||receipt.message.length>512||
    !['registration','attribute','combat'].includes(receipt.verification)||!['applied','not-applied','unknown'].includes(receipt.status)||
    !text(receipt.evidence,128))throw new Error('效果执行回执与冻结许可不符');
  const fingerprint=this.digest(receipt);
  if(receipt.serial<order.receiptSerial)return {ok:false,duplicate:true,message:'旧回执已忽略，保持当前状态',order:copyEffectValue(order)};
  if(receipt.serial===order.receiptSerial)return {ok:fingerprint===order.receiptFingerprint,duplicate:true,message:fingerprint===order.receiptFingerprint?'已确认相同执行回执':'同序号回执内容改变',order:copyEffectValue(order)};
  if(order.charged&&!receipt.charged)throw new Error('已扣款订单不能通过后续回执退款');
  if(!transitions[order.state].includes(receipt.state))throw new Error('效果回执状态倒退或尝试重新执行终态订单');
  if(order.state==='recovery'&&order.charged&&receipt.state==='active')throw new Error('已扣款恢复待办不能通过核查重新激活');
  if(['active','suspended','ended'].includes(receipt.state)&&(!receipt.charged||receipt.status!=='applied'||!verified(receipt.verification,order.offer.definition.verification)))
   throw new Error('生效或交付完成必须有匹配等级的本机核验与扣款');
  if(receipt.state==='reserved'&&(order.offer.definition.delivery!=='nextWave'||receipt.charged))throw new Error('只有未扣款的延迟交付可以预订');
  if(['failed','cancelled'].includes(receipt.state)&&receipt.charged)throw new Error('已扣款订单不能报告为未交付取消');
  if(receipt.state==='failed'&&receipt.status!=='not-applied')throw new Error('缺少确认未交付证据，不能释放名额');
  if(receipt.state==='cancelled'&&receipt.status!=='not-applied')throw new Error('未知交付不能报告取消以释放名额');
  if(receipt.state==='cancelled'&&!['reserved','cancelPending','permitted','failed'].includes(order.state))throw new Error('未知或已生效订单不能取消');
  return this.mutate(()=>{order.state=receipt.state;order.charged=receipt.charged;order.receiptSerial=receipt.serial;order.receiptFingerprint=fingerprint;order.message=receipt.message;
   delete this.state.ready[`${order.context.layer}|${sender}`];return {ok:true,message:'房主已记录购买者本机核验',order:copyEffectValue(order)};});
 }
 lockWave(layer:number,token:number):string[]{
  this.live();this.boundary(layer,token);
  if(this.state.orders.some(o=>['permitted','cancelPending','applying','cleaning','uncertain','recovery','failed'].includes(o.state)))throw new Error('仍有许可、取消或交付恢复待办，不能锁定开战');
  if(this.state.locked.includes(layer))return this.state.orders.filter(o=>o.context.layer===layer&&o.state==='locked').map(o=>o.id);
  return this.mutate(()=>{if(!this.state.locked.includes(layer))this.state.locked.push(layer);
   for(const o of this.state.orders)if(o.context.layer===layer&&o.state==='reserved')o.state='locked';
   return this.state.orders.filter(o=>o.context.layer===layer&&o.state==='locked').map(o=>o.id);});
 }
 preparationDigest(sender:string,layer:number):string{
  if(!this.state.room.members.includes(sender)||!this.state.locked.includes(layer))throw new Error('当前没有该队员的开战许可');
  return this.digest(this.state.orders.filter(o=>o.buyer===sender&&o.context.layer===layer&&!['cancelled','failed','retired'].includes(o.state))
   .map(o=>[o.id,o.offer.revision,o.state,o.charged,o.receiptSerial,o.receiptFingerprint]));
 }
 acknowledgePrepared(sender:string,epoch:string,layer:number,digest:string):void{
  this.peer(sender,this.state.room.session,epoch);
  if(!this.state.locked.includes(layer)||this.state.released.includes(layer)||this.preparationDigest(sender,layer)!==digest)throw new Error('效果准备摘要已变化');
  if(this.state.orders.some(o=>o.buyer===sender&&o.context.layer===layer&&!['active','ended','cancelled','retired'].includes(o.state)))throw new Error('本队员效果尚未实际核验');
  this.mutate(()=>{this.state.ready[`${layer}|${sender}`]=digest;});
 }
 releaseWave(layer:number):void{
  this.live();if(!this.state.locked.includes(layer))throw new Error('尚未锁定效果准备');
  if(this.state.released.includes(layer))return;
  if(!this.state.room.members.every(sender=>this.state.ready[`${layer}|${sender}`]===this.preparationDigest(sender,layer)))throw new Error('尚未收到所有固定队员的效果准备核验');
  this.mutate(()=>{this.state.released.push(layer);});
 }
 peerStatus(sender:string,epoch:string,layer:number,token:number){
  this.peer(sender,this.state.room.session,epoch);this.boundary(layer,token);
  const locked=this.state.locked.includes(layer);
  return {locked,released:this.state.released.includes(layer),digest:locked?this.preparationDigest(sender,layer):null};
 }
 peerBoundary(sender:string,epoch:string):EffectBoundary{
  this.peer(sender,this.state.room.session,epoch);return copyEffectValue(this.port.boundary());
 }
 peerOrder(sender:string,epoch:string,id:string):EffectCommitment{
  this.peer(sender,this.state.room.session,epoch);
  const order=this.state.orders.find(o=>o.id===id&&o.buyer===sender&&o.epoch===epoch);
  if(!order)throw new Error('没有本队员的效果订单');return copyEffectValue(order);
 }
 close(reason:string):void{this.fatalReason=reason;this.mutate(()=>{this.state.closed=true;this.state.reason=reason;});}
}
