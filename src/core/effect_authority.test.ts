import {createHash} from 'node:crypto';
import {expect,it} from 'vitest';
import {EffectAuthority,type EffectBuyIntent,type EffectPeerReceipt,type EffectCommitment,type EffectBoundary} from './effect_authority';
import type {EffectOffer} from './effect_contract';
const room={lobby:'1000',owner:'100',session:'mp-run-1',members:['100','200']};
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function product(id='attack',amount=10,price=30):EffectOffer{
 const offer:EffectOffer={id,name:id,price,enabled:true,revision:'',
  definition:{id:'attack.flat',version:'1',implementation:'a'.repeat(64),name:'攻击',description:'原生属性',delivery:'nextWave',verification:'attribute',experimental:false,
   group:'attack.flat',recoveryScope:'runtimeAttribute',rebindOnNativeReset:true,supportedPhases:['Preparing','Selecting'],quantityParameter:'amount',
   parameters:{amount:{name:'加成',description:'固定值',unit:'点',min:1,max:100,default:10}}},
  effect:{id:'attack.flat',version:'1',parameters:{amount}},groupRule:{policy:'add',cap:30},conditions:{phases:['Selecting'],fromLayer:1,toLayer:99,weapons:[],exclusiveGroups:[]}};
 offer.revision=digest(offer);return offer;
}
function fixture(){
 const products:Record<string,EffectOffer>={attack:product(),large:product('large',20),expensive:product('expensive',1,100)};
 const boundary:EffectBoundary={layer:1,token:8,phase:'Selecting',accepting:true};const writes:unknown[]=[];let fail=false;
 const port={boundary:()=>boundary,offer:(id:string)=>{if(!products[id])throw Error('unknown product');return products[id]!;},fingerprint:digest,
  persist:(value:unknown)=>{if(fail)throw Error('disk full');writes.push(structuredClone(value));}};
 const authority=new EffectAuthority(room,port);authority.registerPeer('100','p1-epoch-1');authority.registerPeer('200','p2-epoch-1');
 const intent=(buyer='100',id='r1',idProduct='attack'):EffectBuyIntent=>({session:room.session,epoch:buyer==='100'?'p1-epoch-1':'p2-epoch-1',id,product:idProduct,
  revision:products[idProduct]!.revision,layer:boundary.layer,token:boundary.token,weapon:2,balance:150});
 const receipt=(order:EffectCommitment,state:EffectPeerReceipt['state']='reserved',serial=1):EffectPeerReceipt=>({session:room.session,epoch:order.epoch,order:order.id,
  serial,state,charged:['active','suspended','ended','cleaning','recovery'].includes(state),nativeOrder:order.nativeOrder,revision:order.offer.revision,
  verification:'attribute',status:['reserved','cancelled','failed'].includes(state)?'not-applied':state==='uncertain'?'unknown':'applied',evidence:digest([state,serial]),message:state});
 return {authority,products,boundary,port,writes,intent,receipt,fail:()=>{fail=true;}};
}
it('serializes a team last slot before any native execution and keeps rejected IDs rejected after cancellation',()=>{
 const f=fixture();f.products.attack!.conditions.limit={count:1,scope:'teamRun'};
 const first=f.authority.authorizeBuy('100',f.intent()).order!;
 const second=f.intent('200','r2');expect(f.authority.authorizeBuy('200',second)).toMatchObject({ok:false});
 f.authority.report('100',f.receipt(first));
 f.authority.authorizeCancel('100',{session:room.session,epoch:first.epoch,id:'cancel',order:first.id,layer:1,token:8});
 expect(f.authority.authorizeBuy('200',f.intent('200','r3')).ok).toBe(false);
 f.authority.report('100',f.receipt(first,'cancelled',2));
 expect(f.authority.authorizeBuy('200',second)).toMatchObject({ok:false,duplicate:true});
 expect(f.authority.authorizeBuy('200',f.intent('200','r4')).ok).toBe(true);
});
it('freezes terms, deduplicates identical requests and rejects changed payloads under the same ID',()=>{
 const f=fixture(),intent=f.intent();const original=f.authority.authorizeBuy('100',intent).order!;
 f.products.attack!.price=500;f.products.attack!.effect.parameters.amount=99;
 expect(f.authority.authorizeBuy('100',intent)).toMatchObject({ok:true,duplicate:true,order:{offer:{price:30,effect:{parameters:{amount:10}}}}});
 expect(f.authority.authorizeBuy('100',{...intent,weapon:0}).ok).toBe(false);expect(f.authority.snapshot().orders).toHaveLength(1);
 expect(original.charged).toBe(false);
});
it('counts pending commitments toward the buyer cap and available funds while preserving individual ownership',()=>{
 const f=fixture();expect(f.authority.authorizeBuy('100',f.intent('100','large1','large')).ok).toBe(true);
 expect(f.authority.authorizeBuy('100',f.intent('100','large2','large')).ok).toBe(false);
 expect(f.authority.authorizeBuy('200',f.intent('200','large3','large')).ok).toBe(true);
 f.authority.authorizeBuy('100',f.intent('100','small','attack'));
 expect(f.authority.authorizeBuy('100',f.intent('100','money','expensive')).message).toContain('可用 PT 不足');
});
it('rejects stale generations and late foreign receipts before any replay lookup',()=>{
 const f=fixture();const intent=f.intent(),order=f.authority.authorizeBuy('100',intent).order!;
 expect(()=>f.authority.authorizeBuy('100',{...intent,epoch:'old'})).toThrow('代号');
 expect(()=>f.authority.authorizeBuy('100',{...intent,session:'old'})).toThrow('代号');
 expect(()=>f.authority.report('200',{...f.receipt(order),epoch:'p2-epoch-1'})).toThrow('他人');
 expect(()=>f.authority.report('100',{...f.receipt(order),revision:'forged'})).toThrow('冻结许可');
 expect(f.authority.snapshot().orders[0]!.state).toBe('permitted');
});
it('cannot emit or grant another permit after an ambiguous journal write',()=>{
 const f=fixture(),before=f.authority.snapshot();f.fail();expect(()=>f.authority.authorizeBuy('100',f.intent())).toThrow('disk full');
 expect(f.authority.snapshot().orders).toEqual(before.orders);expect(f.authority.snapshot().closed).toBe(true);
 expect(()=>f.authority.authorizeBuy('200',f.intent('200','after'))).toThrow('写入结果不明');
});
it('also fences a journal which was written successfully but failed readback',()=>{
 const f=fixture();f.port.persist=value=>{f.writes.push(structuredClone(value));throw Error('readback failed');};
 expect(()=>f.authority.authorizeBuy('100',f.intent())).toThrow('readback failed');
 expect((f.writes.at(-1) as {orders:unknown[]}).orders).toHaveLength(1);
 expect(()=>f.authority.authorizeBuy('200',f.intent('200','after'))).toThrow('写入结果不明');
});
it('fails closed if the digest provider is unavailable',()=>{
 const f=fixture();f.port.fingerprint=()=>'';
 expect(()=>f.authority.authorizeBuy('100',f.intent())).toThrow('摘要不可用');expect(f.authority.snapshot().orders).toEqual([]);
});
it('keeps a peer-generation fence closed even if recording that closure fails',()=>{
 const f=fixture();f.fail();expect(()=>f.authority.registerPeer('200','p2-epoch-2')).toThrow('disk full');
 expect(f.authority.snapshot().closed).toBe(true);expect(()=>f.authority.authorizeBuy('100',f.intent())).toThrow('更换');
});
it('fences the whole authority after a peer reset and never resumes a recovered live journal',()=>{
 const f=fixture();f.authority.authorizeBuy('100',f.intent());const saved=f.authority.snapshot();
 expect(()=>f.authority.registerPeer('200','p2-epoch-2')).toThrow('更换');expect(f.authority.snapshot().closed).toBe(true);
 expect(()=>f.authority.authorizeBuy('100',f.intent('100','later'))).toThrow('更换');
 const restored=new EffectAuthority(room,f.port,saved);expect(()=>restored.authorizeBuy('100',f.intent())).toThrow('不能重放');
});
it('requires actual paid receipts and every fixed peer before releasing a locked wave',()=>{
 const f=fixture(),a=f.authority.authorizeBuy('100',f.intent()).order!,b=f.authority.authorizeBuy('200',f.intent('200','r2')).order!;
 expect(()=>f.authority.lockWave(1,8)).toThrow('待办');f.authority.report('100',f.receipt(a));f.authority.report('200',f.receipt(b));
 expect(f.authority.lockWave(1,8)).toHaveLength(2);
 expect(f.authority.authorizeCancel('100',{session:room.session,epoch:a.epoch,id:'cancel',order:a.id,layer:1,token:8}).ok).toBe(false);
 expect(()=>f.authority.report('100',{...f.receipt(a,'active',2),charged:false})).toThrow('扣款');
 f.authority.report('100',f.receipt(a,'active',2));
 f.authority.acknowledgePrepared('100',a.epoch,1,f.authority.preparationDigest('100',1));
 expect(()=>f.authority.releaseWave(1)).toThrow('所有固定队员');
 expect(()=>f.authority.acknowledgePrepared('200',b.epoch,1,f.authority.preparationDigest('200',1))).toThrow('尚未实际核验');
 f.authority.report('200',f.receipt(b,'active',2));f.authority.acknowledgePrepared('200',b.epoch,1,f.authority.preparationDigest('200',1));
 f.authority.releaseWave(1);expect(f.authority.snapshot().released).toEqual([1]);
});
it('does not cancel uncertain delivery, replay an active order, refund it or accept conflicting receipts',()=>{
 const f=fixture(),order=f.authority.authorizeBuy('100',f.intent()).order!;
 const unknown={...f.receipt(order,'uncertain'),charged:false};f.authority.report('100',unknown);
 expect(f.authority.authorizeCancel('100',{session:room.session,epoch:order.epoch,id:'cancel',order:order.id,layer:1,token:8}).ok).toBe(false);
 expect(f.authority.report('100',unknown)).toMatchObject({ok:true,duplicate:true});
 expect(f.authority.report('100',{...unknown,message:'changed'}).ok).toBe(false);
 f.authority.report('100',f.receipt(order,'active',2));
 expect(()=>f.authority.report('100',f.receipt(order,'reserved',3))).toThrow('退款');
 f.authority.report('100',f.receipt(order,'recovery',3));
 expect(()=>f.authority.report('100',f.receipt(order,'active',4))).toThrow('重新激活');
 expect(f.authority.report('100',unknown)).toMatchObject({ok:false,duplicate:true});
});
it('allows explicitly configured instant Carve purchases without reopening already released wave effects',()=>{
 const f=fixture(),item=product('item',1,10);Object.assign(item.definition,{id:'item.grant',group:'item.grant',delivery:'instant',recoveryScope:'inventory',rebindOnNativeReset:false,supportedPhases:['Carve']});
 item.effect.id='item.grant';item.conditions.phases=['Carve'];item.revision=digest(item);f.products.item=item;
 f.boundary.phase='Carve';expect(f.authority.authorizeBuy('100',f.intent('100','too-early','item')).ok).toBe(false);
 f.authority.lockWave(1,8);for(const sender of room.members)f.authority.acknowledgePrepared(sender,sender==='100'?'p1-epoch-1':'p2-epoch-1',1,f.authority.preparationDigest(sender,1));f.authority.releaseWave(1);
 expect(f.authority.authorizeBuy('100',f.intent('100','instant','item')).ok).toBe(true);
 expect(f.authority.authorizeBuy('100',f.intent('100','not-next-wave','attack')).ok).toBe(false);
});
