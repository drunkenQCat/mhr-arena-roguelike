import {EffectAuthority,type AuthorityResult,type EffectCommitment,type EffectPeerReceipt} from './effect_authority';
import type {OrderState} from './effect_orders';
import type {Verification} from './effect_contract';

/** Session, buyer and epoch come from the authenticated mailbox envelope, never
 * from query fields. Native receipts remain on the buyer; only their digest and
 * state cross the wire. Full offers/ledgers never fit the 2048-byte mailbox. */
export type EffectQuery =
 | {op:'buy';product:string;revision:string;layer:number;token:number;weapon:number;balance:number}
 | {op:'cancel';order:string;layer:number;token:number}
 | {op:'report';order:string;serial:number;state:OrderState;charged:boolean;revision:string;nativeOrder:string;
    verification:Verification;status:EffectPeerReceipt['status'];evidence:string;message:string}
 | {op:'status';layer:number;token:number}
 | {op:'prepared';layer:number;token:number;digest:string}
 | {op:'order';order:string};
export interface EffectPermit {id:string;serial:number;nativeOrder:string;revision:string;price:number;state:EffectCommitment['state'];charged:boolean}
export interface EffectReply {ok:boolean;message:string;closed?:boolean;duplicate?:boolean;permit?:EffectPermit;
 staleBoundary?:boolean;
 preparation?:{locked:boolean;released:boolean;digest:string|null}}
const allowed:Record<EffectQuery['op'],string[]>={
 buy:['op','product','revision','layer','token','weapon','balance'],cancel:['op','order','layer','token'],
 report:['op','order','serial','state','charged','revision','nativeOrder','verification','status','evidence','message'],
 status:['op','layer','token'],prepared:['op','layer','token','digest'],order:['op','order'],
};
function parseQuery(value:unknown):EffectQuery{
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('效果业务载荷必须是对象');
 const object=value as Record<string,unknown>,op=object.op;
 if(typeof op!=='string'||!Object.keys(allowed).includes(op))throw new Error('未知效果业务操作');
 const keys=Object.keys(object),fields=allowed[op as EffectQuery['op']];
 if(keys.length!==fields.length||keys.some(k=>!fields.includes(k)))throw new Error('效果业务字段不匹配，不能自行指定身份');
 if(op==='prepared'&&(typeof object.digest!=='string'||object.digest.length!==64))throw new Error('效果准备摘要非法');
 // Semantic fields (quote, numeric bounds, state transitions, receipt identity)
 // are checked once by EffectAuthority. Do not maintain a second rule engine.
 return value as EffectQuery;
}
const compact=(o:EffectCommitment):EffectPermit=>({id:o.id,serial:o.permit,nativeOrder:o.nativeOrder,
 revision:o.offer.revision,price:o.offer.price,state:o.state,charged:o.charged});
/** TSTL strings are UTF8 bytes. A raw slice can cut a Chinese character and
 * make the entire JSON reply unencodable after the business decision ran. */
export function effectWireMessage(value:string):string{
 if(value.length<=96)return value;
 let prefix=value.slice(0,96),start=prefix.length-1;
 if(start<0)return prefix;
 while(start>=0&&prefix.charCodeAt(start)>=128&&prefix.charCodeAt(start)<192)start--;
 if(start<0)return '';
 const lead=prefix.charCodeAt(start),width=lead>=240&&lead<248?4:lead>=224&&lead<240?3:lead>=192&&lead<224?2:1;
 if(start+width>prefix.length)prefix=prefix.slice(0,start);
 // JS harnesses count UTF16; keep surrogate pairs intact there as well.
 const last=prefix.charCodeAt(prefix.length-1);if(last>=55296&&last<=56319)prefix=prefix.slice(0,-1);
 return prefix;
}
const result=(r:AuthorityResult):EffectReply=>({ok:r.ok,message:effectWireMessage(r.message),
 ...(r.duplicate===undefined?{}:{duplicate:r.duplicate}),...(r.order?{permit:compact(r.order)}:{})});

/** Host-only endpoint for PeerMailbox.dispatch. A reply authorizes one frozen
 * local action; it is not a purchase receipt or proof of native delivery. */
export class EffectEndpoint {
 private readonly session:string;
 constructor(private readonly authority:EffectAuthority){this.session=authority.snapshot().room.session;}
 dispatch(sender:string,epoch:string,request:string,value:unknown):EffectReply{
  try{
   const q=parseQuery(value);this.authority.registerPeer(sender,epoch);
   if(q.op==='buy')return result(this.authority.authorizeBuy(sender,{product:q.product,revision:q.revision,layer:q.layer,token:q.token,
    weapon:q.weapon,balance:q.balance,id:request,session:this.session,epoch}));
   if(q.op==='cancel')return result(this.authority.authorizeCancel(sender,{order:q.order,layer:q.layer,token:q.token,id:request,session:this.session,epoch}));
   if(q.op==='report')return result(this.authority.report(sender,{order:q.order,serial:q.serial,state:q.state,charged:q.charged,
    revision:q.revision,nativeOrder:q.nativeOrder,verification:q.verification,status:q.status,evidence:q.evidence,message:q.message,session:this.session,epoch}));
   if(q.op==='order')return {ok:true,message:'本机订单授权状态',permit:compact(this.authority.peerOrder(sender,epoch,q.order))};
   const boundary=this.authority.peerBoundary(sender,epoch);
   if(q.layer!==boundary.layer||q.token!==boundary.token)return {ok:false,staleBoundary:true,message:'只读准备查询的波次已更新；等待正常主从状态同步'};
   // Validate the logical boundary BEFORE publishing a readiness mutation.
   const preparation=this.authority.peerStatus(sender,epoch,q.layer,q.token);
   if(q.op==='prepared')this.authority.acknowledgePrepared(sender,epoch,q.layer,q.digest);
   return {ok:true,message:q.op==='prepared'?'已记录本机实际准备核验':'效果准备状态',
    preparation};
  }catch(e){return {ok:false,message:effectWireMessage(String(e)),closed:this.authority.snapshot().closed};}
 }
}
