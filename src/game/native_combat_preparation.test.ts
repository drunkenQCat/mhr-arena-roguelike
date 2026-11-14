import {expect,it,vi} from 'vitest';
import {NativeCombatPreparation,type PreparationEnemy} from './native_combat_preparation';

function fixture(){
  const state={now:0,required:true,valid:true,ready:false,flag:true,second:false,resolved:false,uid:0,address:10};
  const writes:boolean[]=[];
  const enemy:PreparationEnemy={uid:state.uid,address:state.address,resolved:()=>state.resolved,active:()=>state.flag,setActive:value=>{writes.push(value);state.flag=value;}};
  const inactive:PreparationEnemy={uid:100,address:20,resolved:()=>false,active:()=>state.second,setActive:value=>{state.second=value;}};
  const port={now:()=>state.now,required:()=>state.required,valid:()=>state.valid,nativeReady:()=>state.ready,
    prepare:vi.fn(()=>({ok:true} as {ok:boolean;reason?:string})),enemies:()=>[enemy,inactive],report:vi.fn()};
  const gate=new NativeCombatPreparation(port);
  const begin=()=>gate.begin({id:900102,unique:-123});
  const tick=()=>{state.now++;gate.tick();};
  return {gate,state,port,enemy,writes,begin,tick};
}
it('leaves ordinary quests and scopes without delayed effects unchanged',()=>{
  const f=fixture();f.state.required=false;f.begin();f.tick();expect(f.gate.blocksInput()).toBe(false);expect(f.writes).toEqual([]);
  f.state.required=true;f.state.valid=false;f.begin();f.tick();expect(f.writes).toEqual([]);
});
it('holds only active enemies while player initialization continues, and charges only on native readiness',()=>{
  const f=fixture();f.begin();f.tick();expect(f.state.flag).toBe(false);expect(f.state.second).toBe(false);expect(f.gate.blocksInput()).toBe(true);expect(f.port.prepare).not.toHaveBeenCalled();
  f.state.ready=true;f.tick();expect(f.port.prepare).toHaveBeenCalledTimes(1);expect(f.port.prepare).toHaveBeenCalledWith(-123);expect(f.state.flag).toBe(true);expect(f.state.second).toBe(false);expect(f.gate.blocksInput()).toBe(false);expect(f.writes).toEqual([false,true]);
  f.tick();expect(f.port.prepare).toHaveBeenCalledTimes(1);
});
it('reholds an engine activation while waiting and avoids re-acquisition during release',()=>{
  const f=fixture();const setter=f.enemy.setActive;f.enemy.setActive=value=>{setter(value);f.gate.hold(f.enemy);};
  f.begin();f.tick();f.state.flag=true;f.gate.hold(f.enemy);expect(f.state.flag).toBe(false);
  f.state.ready=true;f.tick();expect(f.state.flag).toBe(true);expect(f.gate.snapshot().held).toBe(0);
});
it('requires an explicit retry after a failed application and never auto repeats it',()=>{
  const f=fixture();f.port.prepare.mockReturnValueOnce({ok:false,reason:'known failed'});f.state.ready=true;f.begin();f.tick();
  expect(f.gate.snapshot()).toMatchObject({state:'blocked',pending:true,reason:'known failed'});f.tick();f.tick();expect(f.port.prepare).toHaveBeenCalledTimes(1);
  expect(f.gate.retry()).toBe(true);f.tick();expect(f.port.prepare).toHaveBeenCalledTimes(2);expect(f.state.flag).toBe(true);
});
it('restores on stop without triggering the pause hook again',()=>{
  const f=fixture();const setter=f.enemy.setActive;f.enemy.setActive=value=>{setter(value);f.gate.hold(f.enemy);};
  f.begin();f.tick();f.gate.end();expect(f.state.flag).toBe(true);expect(f.gate.blocksInput()).toBe(false);expect(f.port.prepare).not.toHaveBeenCalled();
});
it('does not touch reused actors after the native quest identity changes',()=>{
  const f=fixture();f.begin();f.tick();f.state.valid=false;f.state.flag=true;f.tick();expect(f.writes).toEqual([false]);expect(f.gate.blocksInput()).toBe(false);
});
it('keeps combat blocked if the exact held enemy disappears before restoration',()=>{
  const f=fixture();f.begin();f.tick();f.enemy.address=99;f.state.ready=true;f.tick();
  expect(f.gate.snapshot()).toMatchObject({state:'blocked',pending:true,held:1});expect(f.writes).toEqual([false]);
  f.gate.end();expect(f.port.report).toHaveBeenCalledWith('effect-preparation-restore-pending',expect.anything());expect(f.gate.blocksInput()).toBe(false);
});
it('rearms for a new logical wave inside the same native quest but not for duplicate policy calls',()=>{
 const f=fixture();f.state.ready=true;f.gate.begin({id:900103,unique:7},1);f.tick();expect(f.gate.snapshot().state).toBe('ready');
 f.gate.begin({id:900103,unique:7},1);f.tick();expect(f.port.prepare).toHaveBeenCalledTimes(1);
 f.state.ready=false;f.gate.begin({id:900103,unique:7},2);f.tick();expect(f.gate.blocksInput()).toBe(true);
 expect(f.state.flag).toBe(false);expect(f.gate.snapshot().token).toBe(2);
 f.state.ready=true;f.tick();expect(f.port.prepare).toHaveBeenCalledTimes(2);expect(f.state.flag).toBe(true);
});

it('does not pause a dead or captured previous-wave actor retained in the native set list',()=>{
 const f=fixture();f.state.resolved=true;f.begin();f.tick();
 expect(f.writes).toEqual([]);expect(f.gate.snapshot().held).toBe(0);
 // Native cleanup removes the old address while the cross-peer preparation
 // is still pending. There must be no stale restoration ticket blocking play.
 f.enemy.address=99;f.state.ready=true;f.tick();
 expect(f.gate.snapshot()).toMatchObject({state:'ready',pending:false,held:0});
 expect(f.writes).toEqual([]);
});
