import {expect,it,vi} from 'vitest';
import type {NativeWebconsole} from './sdk';
vi.mock('./sdk',()=>({clockSeconds:()=>1,loadWebconsole:()=>({}),rejson:{dump_string:JSON.stringify,load_string:JSON.parse}}));
import {steamMailbox} from './steam_mailbox';
const context={lobby:'1000',owner:'100',self:'200',session:'run1',epoch:'e200',members:['100','200']};
it('does not silently use an old DLL or cross-write the gameplay/config channels',()=>{
 expect(()=>steamMailbox(context,'effects.v1',()=>null,()=>{},{} as NativeWebconsole)).toThrow('0.4.3');
 const write=vi.fn(()=>true),subscribe=vi.fn(()=>true);
 const network={steam_subscribe:subscribe,steam_member_message:write,steam_lobby_message:vi.fn(()=>true),steam_digest:()=> 'a'.repeat(64),
  steam_snapshot:()=>({available:true,reason:'',lobbies:[{id:'1000',owner:'100',self:'200',plan:'untouched',messages:{'effects.v1':''},
   members:[{id:'100',ack:'untouched',messages:{'effects.v1':''}},{id:'200',ack:'untouched',messages:{'effects.v1':''}}]}]})} as unknown as NativeWebconsole;
 const mailbox=steamMailbox(context,'effects.v1',()=>null,()=>{},network);mailbox.tick();
 expect(subscribe).toHaveBeenCalledWith('effects.v1');expect(write).toHaveBeenCalledWith('1000','effects.v1',expect.any(String));
 expect(network.steam_lobby_message).not.toHaveBeenCalled();
});
it('fences ownership changes from the native snapshot before any publication',()=>{
 const writes=vi.fn(()=>true),fail=vi.fn();
 const network={steam_subscribe:()=>true,steam_member_message:writes,steam_lobby_message:writes,steam_digest:()=> 'a'.repeat(64),
  steam_snapshot:()=>({available:true,reason:'',lobbies:[{id:'1000',owner:'999',self:'200',messages:{},members:[{id:'100',messages:{}},{id:'200',messages:{}}]}]})} as unknown as NativeWebconsole;
 const mailbox=steamMailbox(context,'effects.v1',()=>null,fail,network);mailbox.tick();expect(fail).toHaveBeenCalled();expect(writes).not.toHaveBeenCalled();
});
