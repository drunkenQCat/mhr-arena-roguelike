import {createHash} from 'node:crypto';
import {expect,it} from 'vitest';
import {EffectAuthority,type EffectBoundary} from './effect_authority';
import {EffectEndpoint,effectWireMessage,type EffectQuery,type EffectReply,type EffectPermit} from './effect_wire';
import {PeerMailbox} from './peer_mailbox';
import type {EffectOffer} from './effect_contract';

const digest=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
it('keeps reply text bounded and does not split JS surrogate pairs',()=>{
 expect(effectWireMessage('')).toBe('');expect(effectWireMessage('中文🙂 café')).toBe('中文🙂 café');
 expect(effectWireMessage('x'.repeat(95)+'🙂')).toBe('x'.repeat(95));
 expect(effectWireMessage('拒绝'.repeat(100)).length).toBeLessThanOrEqual(96);
});
function fixture(){
 const room={lobby:'1000',owner:'100',session:'effect-room',members:['100','200']};
 const offer:EffectOffer={id:'attack',name:'小攻击强化',enabled:true,price:30,revision:'a'.repeat(64),
  definition:{id:'attack.flat',version:'1',implementation:'b'.repeat(64),name:'攻击',description:'原生属性加成',delivery:'nextWave',verification:'attribute',
   experimental:false,group:'attack.flat',recoveryScope:'runtimeAttribute',rebindOnNativeReset:true,supportedPhases:['Selecting'],quantityParameter:'amount',
   parameters:{amount:{name:'加成',description:'点数',unit:'点',min:1,max:100,default:10}}},
  effect:{id:'attack.flat',version:'1',parameters:{amount:10}},groupRule:{policy:'add',cap:30},
  conditions:{phases:['Selecting'],fromLayer:1,toLayer:99,weapons:[],exclusiveGroups:[],limit:{count:1,scope:'teamRun'}}};
 const boundary:EffectBoundary={layer:1,token:8,phase:'Selecting',accepting:true},writes:unknown[]=[];
 const port={boundary:()=>boundary,offer:()=>offer,fingerprint:digest,persist:(s:unknown)=>{writes.push(structuredClone(s));}};
 const authority=new EffectAuthority(room,port),endpoint=new EffectEndpoint(authority);
 const bus={now:0,owner:'',members:{'100':'','200':''} as Record<string,string>,drop:false,calls:0};
 const failures:string[]=[];
 const make=(self:string)=>new PeerMailbox<EffectQuery,EffectReply>({...room,self,epoch:`e${self}`},{
  now:()=>bus.now,read:()=>({...room,self,ownerValue:bus.owner,members:room.members.map(id=>({id,value:bus.members[id]!}))}),
  writeMember:value=>{bus.members[self]=value;return true;},writeOwner:value=>{if(!bus.drop||!JSON.parse(value).r)bus.owner=value;return true;},
  encode:JSON.stringify,decode:JSON.parse,bytes:s=>Buffer.byteLength(s),fingerprint:digest,
  dispatch:(sender,epoch,id,q)=>{bus.calls++;return endpoint.dispatch(sender,epoch,id,q);},fail:r=>{failures.push(r);},
 });
 const host=make('100'),guest=make('200');
 const rounds=(count=10)=>{for(let i=0;i<count;i++){bus.now++;host.tick();guest.tick();}};rounds();
 const send=(peer:typeof host,id:string,q:EffectQuery)=>{peer.request(id,q);rounds();const r=peer.result(id);expect(r?.state).toBe('reply');return (r as {value:EffectReply}).value;};
 const buy:EffectQuery={op:'buy',product:offer.id,revision:offer.revision,layer:1,token:8,weapon:2,balance:150};
 const report=(p:EffectPermit,state:'reserved'|'active'|'cancelled'|'uncertain',serial=1):EffectQuery=>({op:'report',order:p.id,serial,state,
  charged:state==='active',revision:p.revision,nativeOrder:p.nativeOrder,verification:'attribute',
  status:state==='active'?'applied':state==='uncertain'?'unknown':'not-applied',evidence:digest([p.id,state,serial]),message:state});
 return {room,offer,boundary,writes,port,authority,endpoint,bus,failures,host,guest,rounds,send,buy,report};
}
it('serializes two authenticated peers racing for the final team slot through the real protocol classes',()=>{
 const f=fixture();f.host.request('host-buy',f.buy);f.guest.request('guest-buy',f.buy);f.rounds(15);
 const h=f.host.result('host-buy') as {value:EffectReply},g=f.guest.result('guest-buy') as {value:EffectReply};
 expect(h.value.ok).toBe(true);expect(g.value.ok).toBe(false);expect(f.authority.snapshot().orders).toHaveLength(1);
 expect(f.authority.snapshot().orders[0]!.buyer).toBe('100');expect(h.value.permit!.charged).toBe(false);
 expect(h.value).not.toHaveProperty('offer');expect(JSON.stringify(h.value)).not.toContain('parameters');expect(f.failures).toEqual([]);
});
it('holds a cancelled team slot until the actual buyer cancellation receipt is acknowledged',()=>{
 const f=fixture(),p=f.send(f.guest,'buy',f.buy).permit!;
 f.send(f.guest,'reserved',f.report(p,'reserved'));
 expect(f.send(f.host,'blocked',f.buy).ok).toBe(false);
 expect(f.send(f.guest,'cancel',{op:'cancel',order:p.id,layer:1,token:8}).ok).toBe(true);
 expect(f.send(f.host,'still-held',f.buy).ok).toBe(false);
 f.send(f.guest,'cancelled',f.report(p,'cancelled',2));
 expect(f.send(f.host,'next-buy',f.buy).ok).toBe(true);
 // A denied transaction never silently becomes a grant after room frees up.
 expect(f.send(f.host,'blocked',f.buy).ok).toBe(false);
});
it('does not replay a native action when the host reply is lost',()=>{
 const f=fixture();f.bus.drop=true;f.guest.request('lost',f.buy);f.rounds(7);
 expect(f.bus.calls).toBe(1);expect(f.authority.snapshot().orders).toHaveLength(1);expect(f.guest.result('lost')?.state).toBe('waiting');
 f.bus.drop=false;f.rounds();expect(f.guest.result('lost')?.state).toBe('reply');expect(f.bus.calls).toBe(1);
});
it('requires paid native evidence, exact boundary, and readiness from peers without any purchases',()=>{
 const f=fixture(),p=f.send(f.guest,'buy',f.buy).permit!;f.send(f.guest,'reserved',f.report(p,'reserved'));
 f.authority.lockWave(1,8);
 let prep=f.send(f.guest,'status1',{op:'status',layer:1,token:8}).preparation!;
 expect(f.send(f.guest,'too-early',{op:'prepared',layer:1,token:8,digest:prep.digest!}).ok).toBe(false);
 f.send(f.guest,'active',f.report(p,'active',2));prep=f.send(f.guest,'status2',{op:'status',layer:1,token:8}).preparation!;
 const writes=f.writes.length;
 expect(f.send(f.guest,'old-wave',{op:'prepared',layer:1,token:7,digest:prep.digest!}).ok).toBe(false);
 expect(f.writes).toHaveLength(writes);expect(f.authority.snapshot().ready).toEqual({});
 expect(f.send(f.guest,'ready',{op:'prepared',layer:1,token:8,digest:prep.digest!}).ok).toBe(true);
 expect(()=>f.authority.releaseWave(1)).toThrow('所有固定队员');
 const hp=f.send(f.host,'host-status',{op:'status',layer:1,token:8}).preparation!;
 f.send(f.host,'host-ready',{op:'prepared',layer:1,token:8,digest:hp.digest!});f.authority.releaseWave(1);
 expect(f.send(f.guest,'released',{op:'status',layer:1,token:8}).preparation!.released).toBe(true);
});
it('cannot claim another buyer identity or read their private permit',()=>{
 const f=fixture(),p=f.send(f.host,'buy',f.buy).permit!;
 expect(f.endpoint.dispatch('200','e200','inject',{...f.buy,buyer:'100'})).toMatchObject({ok:false});
 expect(f.send(f.guest,'read-host',{op:'order',order:p.id}).ok).toBe(false);
 expect(f.send(f.guest,'forge-host-receipt',f.report(p,'active')).ok).toBe(false);
 expect(f.authority.snapshot().orders[0]!.state).toBe('permitted');
});
it('does not release unknown delivery or accept new permits after ambiguous persistence',()=>{
 const f=fixture(),p=f.send(f.guest,'buy',f.buy).permit!;
 f.send(f.guest,'unknown',f.report(p,'uncertain'));
 expect(f.send(f.guest,'cancel-unknown',{op:'cancel',order:p.id,layer:1,token:8}).ok).toBe(false);
 expect(f.send(f.host,'team-full',f.buy).ok).toBe(false);expect(()=>f.authority.lockWave(1,8)).toThrow('待办');
 const g=fixture();g.port.persist=s=>{g.writes.push(structuredClone(s));throw Error('readback failed');};
 expect(g.send(g.host,'ambiguous',g.buy)).toMatchObject({ok:false,closed:true});
 expect(g.send(g.guest,'no-retry',g.buy)).toMatchObject({ok:false,closed:true});
});
