import {createHash} from 'node:crypto';
import {expect,it,vi} from 'vitest';
vi.mock('../game/sdk',()=>({rejson:{dump_string:JSON.stringify}}));
import {PeerMailbox,type MailboxContext,type MailboxPort} from './peer_mailbox';
import {canonical} from '../game/wire_canonical';
type Query={value:string};type Response={sender:string;value:string};
const digest=(v:unknown)=>createHash('sha256').update(canonical(v)).digest('hex');
function fixture(){
 const bus={now:0,owner:'',members:{'100':'','200':''} as Record<string,string>,dropReplies:false,exists:true,ownerId:'100'};
 const calls:{sender:string;epoch:string;id:string;query:Query}[]=[],failures:{self:string;reason:string}[]=[];
 let dispatch=(sender:string,_epoch:string,_id:string,q:Query):Response=>({sender,value:q.value});
 const room={lobby:'1000',owner:'100',session:'s1',members:['100','200']};
 function make(self:string,epoch=`e${self}`){
  const context:MailboxContext={...room,self,epoch};
  const port:MailboxPort<Query,Response>={now:()=>bus.now,
   read:()=>bus.exists?{lobby:room.lobby,owner:bus.ownerId,self,ownerValue:bus.owner,members:room.members.map(id=>({id,value:bus.members[id]!}))}:null,
   writeMember:value=>{bus.members[self]=value;return true;},writeOwner:value=>{if(self!=='100')throw Error('guest owner write');
    if(!bus.dropReplies||!JSON.parse(value).r)bus.owner=value;return true;},
   encode:JSON.stringify,decode:JSON.parse,bytes:s=>Buffer.byteLength(s),fingerprint:digest,
   dispatch:(sender,epoch,id,q)=>{calls.push({sender,epoch,id,query:structuredClone(q)});return dispatch(sender,epoch,id,q);},
   fail:reason=>{failures.push({self,reason});}};
  return {mail:new PeerMailbox(context,port),port};
 }
 const host=make('100'),guest=make('200');
 const tick=(which:'both'|'host'|'guest'='both')=>{bus.now++;if(which!=='guest')host.mail.tick();if(which!=='host')guest.mail.tick();};
 const settle=()=>{for(let n=0;n<8;n++)tick();};settle();
 return {bus,host,guest,calls,failures,make,tick,settle,setDispatch:(fn:typeof dispatch)=>{dispatch=fn;}};
}
it('observes all peers and routes simultaneous requests with authenticated member identity',()=>{
 const f=fixture();expect(f.host.mail.ready()).toBe(true);expect(f.guest.mail.ready()).toBe(true);
 f.host.mail.request('host-buy',{value:'host'});f.guest.mail.request('guest-buy',{value:'guest'});f.settle();
 expect(f.calls.map(c=>c.sender)).toEqual(['100','200']);expect(f.calls.map(c=>c.epoch)).toEqual(['e100','e200']);
 expect(f.host.mail.result('host-buy')).toEqual({state:'reply',value:{sender:'100',value:'host'}});
 expect(f.guest.mail.result('guest-buy')).toEqual({state:'reply',value:{sender:'200',value:'guest'}});expect(f.failures).toEqual([]);
});
it('accepts omitted nullable fields emitted by the native Lua JSON binding',()=>{
 const f=fixture();const m=JSON.parse(f.bus.members['200']!);delete m.q;delete m.ack;m.n++;f.bus.members['200']=JSON.stringify(m);
 const h=JSON.parse(f.bus.owner);delete h.r;h.n++;f.bus.owner=JSON.stringify(h);f.tick();expect(f.failures).toEqual([]);
});
it('retries lost reply metadata without dispatching the operation again',()=>{
 const f=fixture();f.bus.dropReplies=true;f.guest.mail.request('r1',{value:'once'});for(let n=0;n<6;n++)f.tick();
 expect(f.calls).toHaveLength(1);expect(f.guest.mail.result('r1')).toEqual({state:'waiting'});
 f.bus.dropReplies=false;f.settle();expect(f.calls).toHaveLength(1);expect(f.guest.mail.result('r1')?.state).toBe('reply');
});
it('deduplicates local IDs and refuses a changed payload before publication',()=>{
 const f=fixture();const no=f.guest.mail.request('r1',{value:'one'});expect(f.guest.mail.request('r1',{value:'one'})).toBe(no);
 expect(()=>f.guest.mail.request('r1',{value:'two'})).toThrow('绑定其他载荷');f.settle();
 expect(f.guest.mail.request('r1',{value:'one'})).toBe(no);f.settle();expect(f.calls).toHaveLength(1);
});
it('checks complete UTF8 byte size before accepting a client request',()=>{
 const f=fixture();const before=f.bus.members['200'];expect(()=>f.guest.mail.request('large',{value:'中'.repeat(1000)})).toThrow('2048');
 expect(f.bus.members['200']).toBe(before);expect(f.guest.mail.busy()).toBe(false);expect(f.calls).toEqual([]);
});
it('fences the host if a member rewrites a previously processed request number',()=>{
 const f=fixture();f.bus.dropReplies=true;f.guest.mail.request('r1',{value:'one'});for(let i=0;i<3;i++)f.tick();expect(f.calls).toHaveLength(1);
 const raw=JSON.parse(f.bus.members['200']!);raw.n+=100;raw.q.payload.value='changed';raw.q.fingerprint=digest({id:raw.q.id,payload:raw.q.payload});f.bus.members['200']=JSON.stringify(raw);f.tick('host');
 expect(f.host.mail.snapshot().failure).toContain('载荷改变');f.settle();expect(f.calls).toHaveLength(1);
});
it('rejects changed epochs before old receipts or requests can be reused',()=>{
 const f=fixture();const raw=JSON.parse(f.bus.members['200']!);raw.e='reset';raw.n++;f.bus.members['200']=JSON.stringify(raw);f.tick('host');
 expect(f.host.mail.snapshot().failure).toContain('代号已更换');expect(()=>f.host.mail.request('new',{value:'x'})).toThrow('代号已更换');
});
it('rejects an owner reset and cannot reuse a receipt from the old epoch',()=>{
 const f=fixture();const raw=JSON.parse(f.bus.owner);raw.e='reset';raw.n++;f.bus.owner=JSON.stringify(raw);f.tick('guest');
 expect(f.guest.mail.snapshot().failure).toContain('房主业务脚本代号已更换');
});
it('ignores another run while requiring fresh heartbeats rather than cached metadata',()=>{
 const f=fixture();f.bus.owner=JSON.stringify({v:1,s:'old-session',e:'old',n:100,r:null});
 for(let n=0;n<20;n++)f.tick('guest');expect(f.guest.mail.ready()).toBe(false);expect(()=>f.guest.mail.request('r1',{value:'x'})).toThrow('尚未确认');
});
it('does not report submission as a reply and never auto retries after a timeout',()=>{
 const f=fixture();f.guest.mail.request('timeout',{value:'unknown'});for(let n=0;n<50;n++)f.tick('guest');
 expect(f.guest.mail.result('timeout')?.state).toBe('uncertain');expect(f.calls).toEqual([]);f.settle();expect(f.calls).toEqual([]);
 expect(()=>f.guest.mail.request('retry',{value:'x'})).toThrow('超时');
});
it('does not expose a response whose digest no longer matches',()=>{
 const f=fixture();f.guest.mail.request('r1',{value:'one'});
 f.tick('guest');
 for(let n=0;n<5&&!JSON.parse(f.bus.owner).r;n++)f.tick('host');
 const raw=JSON.parse(f.bus.owner);expect(raw.r).not.toBeNull();raw.r.payload.value='tampered';raw.n+=1;f.bus.owner=JSON.stringify(raw);f.tick('guest');
 expect(f.guest.mail.result('r1')?.state).toBe('uncertain');expect(f.guest.mail.snapshot().failure).toContain('摘要不匹配');
});
it('fails closed on roster or owner changes without running a dispatcher',()=>{
 const f=fixture();f.guest.mail.request('r1',{value:'one'});f.bus.ownerId='200';f.tick();
 expect(f.host.mail.snapshot().failure).toContain('房间或名册');expect(f.guest.mail.result('r1')?.state).toBe('uncertain');expect(f.calls).toEqual([]);
});
it('fences a dispatcher whose response exceeds the mailbox, without executing it twice',()=>{
 const f=fixture();f.setDispatch(sender=>({sender,value:'x'.repeat(3000)}));f.guest.mail.request('r1',{value:'one'});f.settle();
 expect(f.calls).toHaveLength(1);expect(f.host.mail.snapshot().failure).toContain('2048');f.settle();expect(f.calls).toHaveLength(1);
});
