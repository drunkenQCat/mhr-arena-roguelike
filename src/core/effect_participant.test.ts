import {createHash} from 'node:crypto';
import {expect,it} from 'vitest';
import {EffectParticipant,type EffectParticipantJournal,type EffectParticipantPort} from './effect_participant';
import {EffectOrders,type EffectContext,type EffectOrder} from './effect_orders';
import {PeerMailbox} from './peer_mailbox';
import type {EffectBoundary} from './effect_authority';
import type {EffectOffer} from './effect_contract';

const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
function fixture(){
 const offer:EffectOffer={id:'attack',name:'攻击',price:30,enabled:true,revision:'a'.repeat(64),definition:{id:'attack.flat',version:'1',
  implementation:'b'.repeat(64),name:'攻击',description:'属性加成',delivery:'nextWave',verification:'attribute',experimental:false,group:'attack.flat',
  recoveryScope:'runtimeAttribute',rebindOnNativeReset:true,supportedPhases:['Selecting'],quantityParameter:'amount',
  parameters:{amount:{name:'点数',description:'点数',unit:'点',min:1,max:100,default:10}}},effect:{id:'attack.flat',version:'1',parameters:{amount:10}},
  groupRule:{policy:'add',cap:30},conditions:{phases:['Selecting'],fromLayer:1,toLayer:99,weapons:[],exclusiveGroups:[],limit:{scope:'teamRun',count:1}}};
 const room={lobby:'1000',owner:'100',session:'run',members:['100','200']},bus={now:0,owner:'',members:{'100':'','200':''} as Record<string,string>,drop:false};
 const make=(self:string)=>{
  const state={wallet:150,attribute:0,applications:0,failWrite:false},charged=new Set<string>(),writes:EffectParticipantJournal[]=[],native:EffectOrder[][]=[];
  const boundary:EffectBoundary={layer:1,token:1,phase:'Selecting',accepting:true};
  const context=():EffectContext=>({run:'run',wave:`run/wave-${boundary.layer}`,layer:boundary.layer,phase:boundary.phase,player:self,team:room.members,weapon:2});
  const engine=new EffectOrders({balance:()=>state.wallet,charge:o=>{if(!charged.has(o.id)){state.wallet-=o.offer.price;charged.add(o.id);}},check:()=>null,
   apply:()=>{const before=state.attribute;state.attribute+=10;state.applications++;return {status:'applied',verification:'attribute',message:'native field readback',before,after:state.attribute};},
   inspect:o=>o.evidence!,remove:()=>{state.attribute=0;return {status:'applied',verification:'attribute',message:'restored field'};},
   persist:orders=>{native.push(structuredClone(orders));},fingerprint:hash});
  const port:EffectParticipantPort={now:()=>bus.now,boundary:()=>boundary,context,offer:()=>offer,balance:()=>state.wallet,orders:()=>engine.snapshot(),
   reserve:(o,c,id)=>engine.reserve(o,o.revision,c,id),cancel:id=>engine.cancel(id,self),fingerprint:hash,
   persist:j=>{if(state.failWrite)throw Error('disk readback failed');writes.push(structuredClone(j));},
   network:(dispatch,fail)=>new PeerMailbox({...room,self,epoch:`e${self}`},{now:()=>bus.now,
    read:()=>({...room,self,ownerValue:bus.owner,members:room.members.map(id=>({id,value:bus.members[id]!}))}),
    writeMember:value=>{bus.members[self]=value;return true;},writeOwner:value=>{if(!bus.drop||!JSON.parse(value).r)bus.owner=value;return true;},
    encode:JSON.stringify,decode:JSON.parse,bytes:s=>Buffer.byteLength(s),fingerprint:hash,dispatch,fail}),
  };
  return {peer:new EffectParticipant({...room,self,epoch:`e${self}`},port),port,state,writes,native,boundary,engine,context};
 };
 const host=make('100'),guest=make('200');
 const tick=()=>{bus.now++;host.peer.tick();guest.peer.tick();};
 const until=(predicate:()=>boolean,max=150)=>{for(let i=0;i<max&&!predicate();i++)tick();expect(predicate(),JSON.stringify([host.peer.diagnostic(),guest.peer.diagnostic()])).toBe(true);};
 until(()=>host.peer.diagnostic().ready&&guest.peer.diagnostic().ready);for(let i=0;i<8;i++)tick();
 return {offer,bus,host,guest,tick,until};
}
it('reserves only after a durable host grant, then confirms locally before returning a purchase receipt',()=>{
 const f=fixture();f.guest.peer.submit('buy','buy','attack',f.offer.revision);
 expect(f.guest.engine.snapshot()).toEqual([]);expect(f.guest.peer.result('buy')).toBeNull();
 f.until(()=>f.guest.peer.result('buy')!==null);
 expect(f.guest.peer.result('buy')).toMatchObject({ok:true,order:{state:'reserved',charged:false}});
 expect(f.guest.engine.available('200')).toBe(120);expect(f.guest.state.wallet).toBe(150);expect(f.host.state.wallet).toBe(150);
 const executing=f.guest.writes.find(j=>j.actions.some(a=>a.state==='executing'));expect(executing?.actions[0]?.permit).toBeDefined();
 expect(f.guest.state.applications).toBe(0);expect(f.host.peer.snapshot().authority!.orders[0]!.state).toBe('reserved');
});
it('serializes a simultaneous team quota race without touching the rejected buyer wallet',()=>{
 const f=fixture();f.host.peer.submit('h','buy','attack',f.offer.revision);f.guest.peer.submit('g','buy','attack',f.offer.revision);
 f.until(()=>!!f.host.peer.result('h')&&!!f.guest.peer.result('g'));
 const accepted=[f.host.peer.result('h'),f.guest.peer.result('g')].filter(r=>r!.ok);expect(accepted).toHaveLength(1);
 expect(f.host.engine.snapshot().length+f.guest.engine.snapshot().length).toBe(1);
 expect(f.host.state.wallet).toBe(150);expect(f.guest.state.wallet).toBe(150);
});
it('cancels only after host permission and retains the team quota while cancellation is in transit',()=>{
 const f=fixture();f.guest.peer.submit('buy','buy','attack',f.offer.revision);f.until(()=>!!f.guest.peer.result('buy'));
 const id=f.guest.engine.snapshot()[0]!.id;
 f.guest.peer.submit('cancel','cancel',id);expect(f.guest.engine.snapshot()[0]!.state).toBe('reserved');
 expect(f.guest.peer.busy()).toBe(true);f.until(()=>!!f.guest.peer.result('cancel'));
 expect(f.guest.engine.snapshot()[0]!.state).toBe('cancelled');expect(f.host.peer.snapshot().authority!.orders[0]!.state).toBe('cancelled');
 f.host.peer.submit('take-free-slot','buy','attack',f.offer.revision);f.until(()=>!!f.host.peer.result('take-free-slot'));
 expect(f.host.peer.result('take-free-slot')!.ok).toBe(true);
});
it('requires actual native application and all peers, including one with no orders, before release',()=>{
 const f=fixture();f.guest.peer.submit('buy','buy','attack',f.offer.revision);f.until(()=>!!f.guest.peer.result('buy'));
 expect(f.host.peer.lockWave().ok).toBe(true);f.host.boundary.accepting=false;f.guest.boundary.accepting=false;
 f.until(()=>f.guest.peer.lockWave().ok);
 f.guest.engine.lockForNative('run','run/wave-1');f.guest.engine.lockWave('run','run/wave-1');f.guest.peer.nativePrepared();
 for(let i=0;i<30;i++)f.tick();expect(f.guest.peer.released()).toBe(false);expect(f.guest.state.wallet).toBe(120);expect(f.guest.state.attribute).toBe(10);
 f.host.peer.nativePrepared();f.until(()=>f.host.peer.released()&&f.guest.peer.released());
 expect(f.guest.state.applications).toBe(1);expect(f.guest.state.wallet).toBe(120);
 f.guest.engine.endWave('run','run/wave-1');f.until(()=>f.host.peer.snapshot().authority!.orders[0]!.state==='ended');
 expect(f.guest.state.attribute).toBe(0);
 for(let i=0;i<30;i++)f.tick();expect(f.host.peer.diagnostic().closed).toBe(false);expect(f.guest.peer.diagnostic().closed).toBe(false);
});
it('does not execute a late permit after the local preparation boundary changed',()=>{
 const f=fixture();f.guest.peer.submit('buy','buy','attack',f.offer.revision);f.guest.boundary.accepting=false;
 f.until(()=>!!f.guest.peer.result('buy'));
 expect(f.guest.peer.result('buy')!.ok).toBe(false);expect(f.guest.engine.snapshot()).toEqual([]);expect(f.guest.state.applications).toBe(0);
 expect(f.host.peer.snapshot().authority!.orders[0]!.state).toBe('failed');expect(f.guest.peer.busy()).toBe(false);
});
it('fences a failed buyer journal before any native action',()=>{
 const f=fixture();f.guest.state.failWrite=true;
 expect(()=>f.guest.peer.submit('buy','buy','attack',f.offer.revision)).toThrow('disk readback failed');
 for(let i=0;i<10;i++)f.tick();expect(f.guest.engine.snapshot()).toEqual([]);expect(f.guest.state.applications).toBe(0);
 expect(f.guest.peer.diagnostic().closed).toBe(true);expect(()=>f.guest.peer.submit('again','buy','attack',f.offer.revision)).toThrow('日志结果不明');
});
it('does not re-reserve or execute while a reply is lost, and does not reuse a completed request ID',()=>{
 const f=fixture();f.bus.drop=true;f.guest.peer.submit('buy','buy','attack',f.offer.revision);
 for(let i=0;i<8;i++)f.tick();expect(f.guest.engine.snapshot()).toEqual([]);expect(f.guest.peer.result('buy')).toBeNull();
 f.bus.drop=false;f.until(()=>!!f.guest.peer.result('buy'));expect(f.guest.engine.snapshot()).toHaveLength(1);
 expect(()=>f.guest.peer.submit('buy','buy','attack',f.offer.revision)).toThrow('已使用');
});
it('keeps read-only status alive while normal host and guest run frames advance at different times',()=>{
 const f=fixture();f.host.boundary.layer=2;f.host.boundary.token=2;
 for(let i=0;i<25;i++)f.tick();expect(f.host.peer.diagnostic().closed).toBe(false);expect(f.guest.peer.diagnostic().closed).toBe(false);
 expect(f.guest.peer.released()).toBe(false);
 f.guest.boundary.layer=2;f.guest.boundary.token=2;
 f.until(()=>f.guest.peer.diagnostic().preparation?.layer===2&&f.guest.peer.diagnostic().preparation?.token===2);
 expect(f.host.peer.diagnostic().ready).toBe(true);expect(f.guest.peer.diagnostic().ready).toBe(true);
});
