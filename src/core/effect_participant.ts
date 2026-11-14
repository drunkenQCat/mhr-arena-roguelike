import {EffectAuthority,type EffectAuthoritySnapshot,type EffectBoundary} from './effect_authority';
import {EffectEndpoint,effectWireMessage,type EffectQuery,type EffectReply,type EffectPermit} from './effect_wire';
import {copyEffectValue,type EffectOffer} from './effect_contract';
import type {EffectContext,EffectOrder,OrderResult} from './effect_orders';
import type {MailboxContext,PeerMailbox} from './peer_mailbox';

interface Action {id:string;kind:'buy'|'cancel';request:string;query:EffectQuery;context:EffectContext;offer:EffectOffer;
 permit?:EffectPermit;nativeOrder:string;state:'requesting'|'executing'|'reporting'|'done'|'uncertain';result?:OrderResult}
interface Binding {permit:EffectPermit;serial:number;confirmed:string}
export interface EffectParticipantJournal {schema:1;context:MailboxContext;actions:Action[];bindings:Binding[];
 authority:EffectAuthoritySnapshot|null;closed:boolean;reason:string;retirement?:string}
export interface EffectParticipantPort {
 now():number;
 boundary():EffectBoundary;
 context():EffectContext;
 offer(id:string):EffectOffer;
 balance():number;
 orders():EffectOrder[];
 reserve(offer:EffectOffer,context:EffectContext,request:string):OrderResult;
 cancel(id:string):OrderResult;
 fingerprint(value:unknown):string;
 persist(journal:EffectParticipantJournal):void;
 /** Called on the authenticated owner only; never executes native effects. */
 network(dispatch:(sender:string,epoch:string,id:string,query:EffectQuery)=>EffectReply,fail:(reason:string)=>void):PeerMailbox<EffectQuery,EffectReply>;
}
type Flight={id:string;kind:'action'|'report'|'status'|'prepared';action?:string;order?:string;signature?:string;layer?:number;token?:number};

/** The buyer owns its native journal and wallet. The room owner only serializes
 * permits/quotas. Every native action is fenced by a persisted intent and exact
 * permit; a dropped/unknown outcome is never automatically executed again. */
export class EffectParticipant {
 private state:EffectParticipantJournal;
 private readonly authority:EffectAuthority|null;
 private readonly mail:PeerMailbox<EffectQuery,EffectReply>;
 private flight:Flight|null=null;
 private serial=0;
 private lastStatus=-1;
 private preparation:{layer:number;token:number;locked:boolean;released:boolean;digest:string|null}|null=null;
 private localPrepared:number|null=null;
 private acknowledged:string|null=null;
 private failed:string|null=null;
 constructor(private readonly identity:MailboxContext,private readonly port:EffectParticipantPort){
  this.state={schema:1,context:copyEffectValue(identity),actions:[],bindings:[],authority:null,closed:false,reason:''};
  this.authority=identity.self===identity.owner?new EffectAuthority(identity,{
   boundary:()=>port.boundary(),offer:id=>port.offer(id),fingerprint:v=>port.fingerprint(v),
   persist:s=>{this.state.authority=s;this.save();},
  }):null;
  const endpoint=this.authority?new EffectEndpoint(this.authority):null;
  this.mail=port.network((sender,epoch,id,q)=>endpoint?endpoint.dispatch(sender,epoch,id,q):{ok:false,message:'只有房主可授予效果许可'},r=>this.close(r));
 }
 private save():void{try{this.port.persist(this.snapshot());}catch(e){this.failed=`联机效果日志结果不明：${String(e)}`;throw e;}}
 private live():void{if(this.failed||this.state.closed)throw new Error(this.failed??this.state.reason);}
 snapshot():EffectParticipantJournal{return copyEffectValue({...this.state,closed:this.state.closed||this.failed!==null,reason:this.failed??this.state.reason});}
 diagnostic(){return {ready:this.mail.ready(),busy:this.busy(),reason:this.failed??this.state.reason,closed:this.state.closed||this.failed!==null,
  pending:this.flight?.kind??null,preparation:this.preparation,transport:this.mail.snapshot()};}
 busy():boolean{
  if(this.failed!==null||this.state.actions.some(a=>!['done','uncertain'].includes(a.state)))return true;
  const orders=new Map(this.port.orders().map(o=>[o.id,o]));
  return this.state.bindings.some(b=>{const o=orders.get(b.permit.nativeOrder);return !!o&&this.signature(o)!==b.confirmed;});
 }
 private localOrder(id:string):EffectOrder|undefined{return this.port.orders().find(o=>o.id===id);}
 private signature(order:EffectOrder|undefined):string{return order?this.port.fingerprint(order):'';}
 result(id:string):OrderResult|null{
  const a=this.state.actions.find(a=>a.id===id);if(!a)return null;
  if(a.state==='done'||a.state==='uncertain')return copyEffectValue(a.result??{ok:false,message:this.failed??'交付结果待核实'});
  return null;
 }
 submit(id:string,kind:'buy'|'cancel',productOrOrder:string,revision=''):void{
  this.live();if(!this.mail.ready()||this.busy())throw new Error('全队效果信箱或上一笔交易尚未确认');
  if(typeof id!=='string'||id.length===0||id.length>128||id.includes('|'))throw new Error('效果事务标识非法');
  if(this.state.actions.some(a=>a.id===id))throw new Error('效果事务标识已使用，请查询原回执');
  if(this.state.actions.length>=2048)throw new Error('本局效果事务达到上限，请安全结束本局');
  const c=this.port.context(),b=this.port.boundary();
  if(!b.accepting||c.run!==this.identity.session||c.player!==this.identity.self||c.layer!==b.layer)throw new Error('效果准备边界已改变');
  let offer:EffectOffer,query:EffectQuery,request:string,nativeOrder='';
  if(kind==='buy'){
   offer=this.port.offer(productOrOrder);if(offer.revision!==revision)throw new Error('商品报价已变化，请查看新内容后重新购买');
   request=`b-${id}`;query={op:'buy',product:offer.id,revision,layer:b.layer,token:b.token,weapon:c.weapon,balance:this.port.balance()};
  }else{
   const binding=this.state.bindings.find(v=>v.permit.nativeOrder===productOrOrder),order=this.localOrder(productOrOrder);
   if(!binding||!order||order.state!=='reserved'||order.charged)throw new Error('没有本机可取消的效果预订');
   offer=order.offer;request=`c-${id}`;nativeOrder=order.id;query={op:'cancel',order:binding.permit.id,layer:b.layer,token:b.token};
  }
  const action:Action={id,kind,request,query,offer:copyEffectValue(offer),context:copyEffectValue(c),nativeOrder,state:'requesting'};
  this.state.actions.push(action);this.save();
 }
 private request(query:EffectQuery,flight:Omit<Flight,'id'>,id?:string):void{
  const key=id??`peer-${++this.serial}`;this.mail.request(key,query);this.flight={...flight,id:key};
 }
 private bind(action:Action,permit:EffectPermit):void{
  const nativeOrder=action.kind==='buy'?`${this.identity.session}|${this.identity.self}|${action.request}`:action.nativeOrder;
  if(permit.nativeOrder!==nativeOrder||permit.price!==action.offer.price||permit.revision!==action.offer.revision||
    permit.charged||permit.state!==(action.kind==='buy'?'permitted':'cancelPending'))throw new Error('房主许可与本机冻结承诺不符');
  action.permit=copyEffectValue(permit);action.nativeOrder=nativeOrder;action.state='executing';
  if(!this.state.bindings.some(b=>b.permit.nativeOrder===nativeOrder))this.state.bindings.push({permit:copyEffectValue(permit),serial:0,confirmed:''});
  this.save(); // If this fails, native execution MUST NOT begin.
 }
 private execute(action:Action):void{
  const b=this.port.boundary();
  if(!b.accepting||b.layer!==action.context.layer||b.token!==(action.query as {token:number}).token){
   // No local execution occurred. Keep a durable zero-delivery receipt so the
   // host can release the preoccupied slot, rather than inventing a cancellation.
   action.result={ok:false,message:'许可返回前整备阶段已结束；未执行、未扣款'};action.state='reporting';this.save();return;
  }
  try{
   action.result=action.kind==='buy'?this.port.reserve(action.offer,action.context,action.request):this.port.cancel(action.nativeOrder);
   if(action.result.order&&action.result.order.id!==action.nativeOrder)throw new Error('本机订单标识与房主许可不符');
   action.state='reporting';this.save();
  }catch(e){
   action.result={ok:false,uncertain:true,message:`本机执行结果待核实：${String(e)}`};action.state='uncertain';
   this.failed=action.result.message;this.save();
  }
 }
 private receipt(binding:Binding,order:EffectOrder|undefined):{query:EffectQuery;signature:string}|null{
  const action=this.state.actions.find(a=>a.nativeOrder===binding.permit.nativeOrder&&a.kind==='buy');
  if(!order){
   if(action?.state!=='reporting')return null;
   const query:EffectQuery={op:'report',order:binding.permit.id,serial:binding.serial+1,state:'failed',charged:false,
    revision:binding.permit.revision,nativeOrder:binding.permit.nativeOrder,verification:'registration',status:'not-applied',
    evidence:this.port.fingerprint({id:action.id,result:action.result,zeroDelivery:true}),message:effectWireMessage(action.result?.message??'确认未执行')};
   return {query,signature:this.port.fingerprint(query)};
  }
  const signature=this.signature(order);if(signature===binding.confirmed)return null;
  const evidence=order.state==='ended'&&order.cleanup?order.cleanup:order.evidence;
  const query:EffectQuery={op:'report',order:binding.permit.id,serial:binding.serial+1,state:order.state,charged:order.charged,
   revision:order.offer.revision,nativeOrder:order.id,verification:evidence?.verification??'registration',
   status:evidence?.status??(['reserved','locked','cancelled','failed'].includes(order.state)?'not-applied':'unknown'),
   evidence:this.port.fingerprint({evidence:order.evidence??null,cleanup:order.cleanup??null,retirement:order.retirement??null}),message:effectWireMessage(order.message)};
  return {query,signature};
 }
 private finishReport(binding:Binding,signature:string):void{
  binding.serial++;binding.confirmed=signature;
  // A receipt changes the owner's preparation digest. Never acknowledge a
  // cached status from before the receipt, even on this same local wave.
  this.preparation=null;this.acknowledged=null;this.lastStatus=-1;
  for(const action of this.state.actions.filter(a=>a.nativeOrder===binding.permit.nativeOrder&&a.state==='reporting'))action.state='done';
  this.save();
 }
 private pollReply():void{
  const flight=this.flight;if(!flight)return;const result=this.mail.result(flight.id);if(!result||result.state==='waiting')return;
  this.flight=null;
  if(result.state==='uncertain'){this.close(result.message);return;}
  const reply=result.value;if(reply.closed){this.close(reply.message);return;}
  if(flight.kind==='action'){
   const action=this.state.actions.find(a=>a.id===flight.action)!;
   if(!reply.ok){action.state='done';action.result={ok:false,message:reply.message};this.save();return;}
   if(!reply.permit)throw new Error('房主未返回冻结效果许可');
   this.bind(action,reply.permit);this.execute(action);
  }else if(flight.kind==='report'){
   if(!reply.ok)throw new Error(`房主未接纳本机交付回执：${reply.message}`);
   const binding=this.state.bindings.find(b=>b.permit.id===flight.order);if(!binding)throw new Error('回执绑定已丢失');
   this.finishReport(binding,flight.signature!);
  }else{
   const b=this.port.boundary();if(b.layer!==flight.layer||b.token!==flight.token)return;
   // The owner's regular run frame may advance before this queued read reaches
   // it. Do not fault or copy that new business boundary from an effect reply.
   if(reply.staleBoundary){this.preparation=null;this.acknowledged=null;return;}
   if(!reply.ok)throw new Error(reply.message);if(!reply.preparation)throw new Error('缺少效果准备状态');
   this.preparation={layer:flight.layer!,token:flight.token!,...reply.preparation};
   if(flight.kind==='prepared')this.acknowledged=reply.preparation.digest;
  }
 }
 /** Host serializes cancellation vs lock. Repeated lock calls never reapply a
  * native effect; local application is exclusively the native preparation port. */
 lockWave():{ok:boolean;reason?:string}{
  try{
   this.live();if(!this.mail.ready()||this.busy())return {ok:false,reason:'等待全队效果交易核验完成'};
   const b=this.port.boundary();if(this.authority)this.authority.lockWave(b.layer,b.token);
   else if(!this.preparation?.locked||this.preparation.layer!==b.layer)return {ok:false,reason:'等待房主锁定本波效果'};
   return {ok:true};
  }catch(e){return {ok:false,reason:String(e)};}
 }
 nativePrepared():void{this.localPrepared=this.port.boundary().layer;}
 released():boolean{const b=this.port.boundary();return !this.failed&&this.preparation?.layer===b.layer&&this.preparation.token===b.token&&this.preparation.released===true;}
 tick():void{
  if(this.state.closed||this.failed)return;
  try{
   this.mail.tick();this.pollReply();if(this.state.closed||this.failed||this.flight||!this.mail.ready())return;
   // A native order snapshot deep-copies frozen offers/evidence. Take it once,
   // rather than copying the entire history separately for every binding.
   const orders=new Map(this.port.orders().map(o=>[o.id,o]));
   for(const binding of this.state.bindings){const receipt=this.receipt(binding,orders.get(binding.permit.nativeOrder));if(receipt){
    this.request(receipt.query,{kind:'report',order:binding.permit.id,signature:receipt.signature});return;}}
   const action=this.state.actions.find(a=>a.state==='requesting');
   if(action){this.request(action.query,{kind:'action',action:action.id},action.request);return;}
   const b=this.port.boundary();
   if(this.authority&&this.state.authority?.locked.includes(b.layer)&&!this.state.authority.released.includes(b.layer)){
    const snapshot=this.authority.snapshot();
    if(snapshot.room.members.every(p=>snapshot.ready[`${b.layer}|${p}`]===this.authority!.preparationDigest(p,b.layer)))this.authority.releaseWave(b.layer);
   }
   if(this.localPrepared===b.layer&&this.preparation?.layer===b.layer&&this.preparation.token===b.token&&this.preparation.locked&&!this.preparation.released&&
      this.preparation.digest!==null&&this.acknowledged!==this.preparation.digest){
    this.request({op:'prepared',layer:b.layer,token:b.token,digest:this.preparation.digest},{kind:'prepared',layer:b.layer,token:b.token});return;
   }
   if(this.port.now()-this.lastStatus>=2){this.lastStatus=this.port.now();this.request({op:'status',layer:b.layer,token:b.token},{kind:'status',layer:b.layer,token:b.token});}
  }catch(e){this.close(String(e));}
 }
 close(reason:string):void{
  if(this.state.closed)return;this.state.closed=true;this.state.reason=reason;
  for(const a of this.state.actions)if(a.state!=='done'){a.state='uncertain';a.result={ok:false,uncertain:true,message:`结果待核实：${reason}`};}
  this.mail?.close(reason);try{this.save();}catch{/* Never un-fence after a failed closing write. */}
 }
 retire(proof:string):void{
  if(proof.length!==64)throw new Error('缺少联机效果恢复与原生保存证明');
  this.close('本局已结束并完成原资源恢复');this.state.retirement=proof;this.save();
 }
}
