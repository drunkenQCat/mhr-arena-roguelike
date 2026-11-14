import {PeerMailbox,type MailboxContext,type MailboxPort} from '../core/peer_mailbox';
import {clockSeconds,loadWebconsole,rejson,type NativeWebconsole} from './sdk';
import {canonical} from './wire_canonical';

/** Native Steam metadata adapter, called only on the host Lua update thread.
 * HTTP threads never access this object or Steam/game state. */
export function steamMailbox<Q,R>(context:MailboxContext,channel:string,
 dispatch:MailboxPort<Q,R>['dispatch'],fail:(reason:string)=>void,network:NativeWebconsole=loadWebconsole()):PeerMailbox<Q,R>{
 if(!network.steam_subscribe||!network.steam_lobby_message||!network.steam_member_message||!network.steam_snapshot||!network.steam_digest)
  throw new Error('业务联机通道需要 webconsole 0.4.3 或更新版本；请完整更新后重启游戏');
 if(!network.steam_subscribe(channel))throw new Error('业务联机频道非法或已达到原生上限');
 return new PeerMailbox(context,{
  now:clockSeconds,
  read:()=>{
   const snapshot=network.steam_snapshot!();if(!snapshot.available)throw new Error(snapshot.reason||'Steam 业务快照不可用');
   const lobby=snapshot.lobbies.find(l=>l.id===context.lobby);if(!lobby)return null;
   if(!lobby.messages||lobby.members.some(m=>!m.messages))throw new Error('插件缺少业务通道快照，请全队更新并重启游戏');
   return {lobby:lobby.id,owner:lobby.owner,self:lobby.self,ownerValue:lobby.messages[channel]??'',
    members:lobby.members.map(m=>({id:m.id,value:m.messages![channel]??''}))};
  },
  writeMember:value=>network.steam_member_message!(context.lobby,channel,value),
  writeOwner:value=>network.steam_lobby_message!(context.lobby,channel,value),
  encode:value=>rejson.dump_string(value,-1),decode:value=>rejson.load_string(value),
  // Lua strings count bytes; this is deliberately not JS UTF16 length.
  bytes:value=>value.length,fingerprint:value=>network.steam_digest!(canonical(value)),dispatch,fail,
 });
}
