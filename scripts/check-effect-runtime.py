"""Exercise the emitted order engine AND real Lua effect programs without JS globals."""
from pathlib import Path
import json
import hashlib
from lupa.lua54 import LuaRuntime, lua_type

root = Path(__file__).resolve().parent.parent
bundle = (root / "reframework/autorun/mhw_rogue.lua").read_text(encoding="utf-8")
entry = 'local ____entry = require("src.game.main", ...)\nreturn ____entry'
assert bundle.count(entry) == 1
lua = LuaRuntime(unpack_returned_tuples=True)
modules = lua.execute(bundle.replace(entry, 'return require("src.core.effect_orders")'))
program = lua.execute((root / "reframework/effects/attack_flat.lua").read_text(encoding="utf-8"))
lua.eval('''function(Orders, program)
  assert(Array == nil and Date == nil and JSON == nil)
  local stat, balance, applications, removals = 0, 150, 0, 0
  local charged = {}
  local api = {
    check_stat = function(field, amount) assert(field == "_AtkUpAlive"); return nil end,
    add_stat = function(field, amount)
      local before = stat; stat = stat + amount; applications = applications + 1
      return {status="applied",verification="attribute",message="field readback",before=before,after=stat,
        handle={before=before,after=stat}}
    end,
    inspect_stat = function(evidence) return evidence end,
    restore_stat = function(evidence)
      assert(stat == evidence.handle.after, "reverse-order ownership lost")
      stat = evidence.handle.before; removals = removals + 1
      return {status="applied",verification="attribute",message="cleanup readback"}
    end
  }
  local engine = setmetatable({}, Orders.prototype)
  engine:____constructor({balance=function() return balance end,
    charge=function(_,o) if not charged[o.id] then balance=balance-o.offer.price; charged[o.id]=true end end,
    check=function(_,offer) return program.check(api,offer.effect.parameters) end,
    apply=function(_,o) return program.apply(api,o.offer.effect.parameters) end,
    inspect=function(_,o) return program.inspect(api,o.offer.effect.parameters,o.evidence) end,
    remove=function(_,o) return program.remove(api,o.offer.effect.parameters,o.evidence) end,
    persist=function(_,orders) assert(type(orders)=="table") end,
    fingerprint=function(_,x) return x.offer.id .. x.offer.revision .. x.context.wave end
  })
  local definition=program.definition; definition.implementation="tested-source"
  local offer={id="small",name="test",price=30,enabled=true,revision="v1",definition=definition,
    effect={id=definition.id,version="1",parameters={amount=10}},groupRule={policy="add",cap=30},
    conditions={phases={"Selecting"},fromLayer=1,toLayer=99,weapons={},exclusiveGroups={}}}
  local context={run="r1",player="local",wave="r1/w1",layer=1,phase="Selecting",weapon=-1,team={"local"}}
  assert(engine:check(offer,context)==nil, "empty weapon restrictions must allow the product")
  assert(not engine:reserve(offer,"stale",context,"stale").ok)
  local first=engine:reserve(offer,"v1",context,"r1");assert(first.ok)
  assert(engine:available("local")==120 and balance==150 and applications==0)
  assert(engine:reserve(offer,"v1",context,"r1").duplicate)
  offer.effect.parameters.amount=20;offer.revision="v2"
  local second=engine:reserve(offer,"v2",context,"r2");assert(second.ok)
  assert(not engine:reserve(offer,"v2",context,"r3").ok, "all reservations must count toward the group cap")
  engine:lockForNative("r1","r1/w1")
  assert(stat==0 and balance==150 and applications==0, "initial entry must not write village attributes or debit")
  assert(engine:snapshot()[1].state=="locked" and not engine:cancel(first.order.id,"local").ok)
  assert(engine:lockWave("r1","r1/w1").ok)
  assert(stat==30 and balance==90 and applications==2)
  assert(not engine:cancel(first.order.id,"local").ok)
  assert(engine:lockWave("r1","r1/w1").ok and applications==2)
  engine:endWave("r1","r1/w1")
  assert(stat==0 and removals==2 and engine:reserved("local")==0)
  for _,o in ipairs(engine:snapshot()) do assert(o.state=="ended" and o.charged) end
  return true
end''')(modules.EffectOrders, program)
print("PASS Lua 5.4: actual attack script, empty restrictions, frozen reservations, shared cap, no replay, reverse cleanup")

# Optional chaining in a multi-variable declaration once compiled its temporary
# before the preceding local was declared. Execute the emitted adapter as well
# as the pure ledger so a JS-only suite cannot hide that regression.
lua.execute('sdk={PreHookResult={}}; re={}; thread={}')
adapter = lua.execute(bundle.replace(entry, 'return require("src.game.designer_effects")'))
lua.eval('''function(C)
  local s={stage="Carve",readingSnapshot={quest={playing=true,id=900102,unique=17}},
    shopQuest=function() return nil end}
  local o=setmetatable({session=function() return s end},C.prototype)
  local r=o:tradeContext()
  assert(r.questId==900102 and r.questUnique==17)
  s.stage="Selecting";assert(o:tradeContext()==nil)
end''')(adapter.DesignerEffects)
print("PASS Lua 5.4: emitted native trade context in Carve and Selecting")

lua.execute('''fs={read=function()return "" end,glob=function()return {}end};json={}
 package.loaded.webconsole={epoch=function()return 2 end,session_id=function()return "p1"end,
  steam_subscribe=function(channel)assert(channel=="effects_v1");return true end,
  steam_lobby_message=function()return true end,steam_member_message=function()return true end,
  steam_snapshot=function()return {available=true,lobbies={}}end,steam_digest=function()return string.rep('a',64)end}''')
attached_adapter = lua.execute(bundle.replace(entry, 'return require("src.game.designer_effects")'))
lua.eval('''function(C)
 local o=setmetatable({session=function()return {core={config={effectShop={products={{id="attack"}},groups={}}}}}end,
   catalog={offer=function(_,product)return product end},
   start=function(self)self.owner={process="p1"};self.engine={snapshot=function()return {}end}end},C.prototype)
 o:attachMultiplayer({lobby="1000",owner="100",self="100",session="mp",members={"100","200"}})
 assert(o:multiplayerAttached() and o.peer:snapshot().context.epoch=="p1-2")
 assert(o.peer.port:offer("attack").id=="attack")
end''')(attached_adapter.DesignerEffects)
print('PASS Lua 5.4: actual game adapter attaches the authenticated peer without optional-chain declaration hoisting')

config_module=lua.execute(bundle.replace(entry, 'return require("src.core.config")'))
raw=json.loads((root/'data/rogue_config.json').read_text(encoding='utf-8'))
raw['effectShop']={'groups':{'test':{'policy':'unique','cap':1}},'products':[{
 'id':'test_empty_parameters','name':'无参数效果','price':1,'enabled':True,
 'effect':{'id':'test','version':'1','parameters':{}},
 'conditions':{'phases':['Selecting'],'fromLayer':1,'toLayer':99,'weapons':[],'exclusiveGroups':[]}}]}
parsed=config_module.validateConfig(None,lua.table_from(raw,recursive=True))
assert parsed.effectShop.products[1].effect.id=='test'
contract=lua.execute(bundle.replace(entry, 'return require("src.core.effect_contract")'))
definition=lua.table_from({'id':'test','name':'无参数','description':'不写游戏','version':'1','implementation':'source',
 'delivery':'nextWave','verification':'attribute','experimental':False,'group':'test','parameters':{}},recursive=True)
contract.validateEffectDefinition(None,definition)
print('PASS Lua 5.4: empty parameter records and no-argument effect definitions')

# The authority has no SDK/global JSON dependency. Execute its emitted Lua too,
# including port-method binding and the actual shared eligibility ledger.
def authority_plain(value):
    if lua_type(value) != 'table':
        return value
    keys = list(value.keys())
    if all(isinstance(k, int) and not isinstance(k, bool) for k in keys) and sorted(keys) == list(range(1, len(keys)+1)):
        return [authority_plain(value[i]) for i in range(1, len(keys)+1)]
    return {str(k): authority_plain(value[k]) for k in keys}

lua.globals().authority_digest = lambda value: hashlib.sha256(json.dumps(authority_plain(value), ensure_ascii=False, sort_keys=True).encode()).hexdigest()
authority = lua.execute(bundle.replace(entry, 'return require("src.core.effect_authority")'))
lua.eval('''function(C, program)
  local writes=0
  local definition=program.definition;definition.implementation=string.rep('a',64)
  local offer={id="attack",name="attack",price=30,enabled=true,revision=string.rep('b',64),definition=definition,
    effect={id=definition.id,version="1",parameters={amount=10}},groupRule={policy="add",cap=30},
    conditions={phases={"Selecting"},fromLayer=1,toLayer=99,weapons={},exclusiveGroups={},limit={count=1,scope="teamRun"}}}
  local a=setmetatable({},C.prototype)
  a:____constructor({lobby="1000",owner="100",session="r-mp",members={"100","200"}}, {
    boundary=function()return {layer=1,token=8,phase="Selecting",accepting=true}end,
    offer=function(_,id)assert(id=="attack");return offer end,
    fingerprint=function(_,value)return authority_digest(value)end,
    persist=function(_,snapshot)assert(snapshot.schema==1);writes=writes+1 end,
  })
  a:registerPeer("100","e1");a:registerPeer("200","e2")
  local intent={session="r-mp",epoch="e1",id="r1",product="attack",revision=offer.revision,layer=1,token=8,weapon=2,balance=150}
  local first=a:authorizeBuy("100",intent);assert(first.ok and not first.order.charged)
  intent.epoch="e2";intent.id="r2"
  assert(not a:authorizeBuy("200",intent).ok,"last team slot must already be reserved")
  local receipt={session="r-mp",epoch="e1",order=first.order.id,serial=1,state="reserved",charged=false,
    revision=offer.revision,nativeOrder=first.order.nativeOrder,verification="attribute",status="not-applied",evidence=string.rep('c',64),message="reserved"}
  assert(a:report("100",receipt).ok)
  a:lockWave(1,8)
  receipt.serial=2;receipt.state="active";receipt.charged=true;receipt.status="applied";receipt.message="actual readback"
  assert(a:report("100",receipt).ok)
  a:acknowledgePrepared("100","e1",1,a:preparationDigest("100",1))
  assert(not pcall(function()a:releaseWave(1)end),"a peer without orders still needs to acknowledge")
  a:acknowledgePrepared("200","e2",1,a:preparationDigest("200",1));a:releaseWave(1)
  assert(a:snapshot().released[1]==1 and writes>=7)
end''')(authority.EffectAuthority, program)
print('PASS Lua 5.4: host team quota, frozen native receipt identity, paid readiness and all-peer release')

lua.globals().mail_encode = lambda value: json.dumps(authority_plain(value), ensure_ascii=False, sort_keys=True, separators=(',', ':'))
lua.globals().mail_decode = lambda text: lua.table_from(json.loads(text), recursive=True)
mailbox = lua.execute(bundle.replace(entry, 'return require("src.core.peer_mailbox")'))
lua.eval('''function(C)
  local bus={now=0,owner="",members={["100"]="",["200"]=""},calls=0,drop=false,failures=0}
  local function make(self)
    local m=setmetatable({},C.prototype)
    m:____constructor({lobby="1000",owner="100",self=self,session="mail-run",epoch="e"..self,members={"100","200"}}, {
      now=function()return bus.now end,
      read=function()return {lobby="1000",owner="100",self=self,ownerValue=bus.owner,members={{id="100",value=bus.members["100"]},{id="200",value=bus.members["200"]}}}end,
      writeMember=function(_,value)bus.members[self]=value;return true end,
      writeOwner=function(_,value)assert(self=="100");local frame=mail_decode(value);if not bus.drop or not frame.r then bus.owner=value end;return true end,
      encode=function(_,value)return mail_encode(value)end,decode=function(_,value)return mail_decode(value)end,
      bytes=function(_,value)return #value end,fingerprint=function(_,value)return authority_digest(value)end,
      dispatch=function(_,sender,epoch,id,query)bus.calls=bus.calls+1;return {sender=sender,epoch=epoch,id=id,value=query.value}end,
      fail=function()bus.failures=bus.failures+1 end,
    })
    return m
  end
  local host,guest=make("100"),make("200")
  local function rounds(count)for i=1,count do bus.now=bus.now+1;host:tick();guest:tick()end end
  rounds(8);assert(host:ready()and guest:ready())
  guest:request("g1",{value="中文"});host:request("h1",{value="host"});rounds(12)
  assert(bus.calls==2 and guest:result("g1").state=="reply" and guest:result("g1").value.sender=="200")
  assert(host:result("h1").value.sender=="100" and bus.failures==0)
  guest:request("g1",{value="中文"});rounds(3);assert(bus.calls==2)
  assert(not pcall(function()guest:request("too-big",{value=string.rep("中",1000)})end))
  bus.drop=true;guest:request("g2",{value="lost reply"});rounds(5)
  assert(bus.calls==3 and guest:result("g2").state=="waiting")
  bus.drop=false;rounds(8);assert(bus.calls==3 and guest:result("g2").state=="reply" and bus.failures==0)
end''')(mailbox.PeerMailbox)
print('PASS Lua 5.4: two-peer mailbox, sender binding, UTF8 byte bounds, cached IDs and lost-reply recovery (simulated transport)')

wire = lua.execute(bundle.replace(entry, 'return require("src.core.effect_wire")'))
assert wire.effectWireMessage(None, 'x' + '中' * 100) == 'x' + '中' * 31
assert wire.effectWireMessage(None, 'xxx' + '🙂' * 100) == 'xxx' + '🙂' * 23
lua.eval('''function(A,E,C,P)
  local boundary={layer=1,token=8,phase="Selecting",accepting=true}
  local offer={id="attack",name="攻击强化",price=30,enabled=true,revision=string.rep('a',64),
    definition=P.definition,effect={id="attack.flat",version=P.definition.version,parameters={amount=10}},
    groupRule={policy="add",cap=30},conditions={phases={"Selecting"},fromLayer=1,toLayer=99,weapons={},exclusiveGroups={},limit={count=1,scope="teamRun"}}}
  offer.definition.implementation=string.rep('b',64)
  local authority=setmetatable({},A.prototype)
  authority:____constructor({lobby="1000",owner="100",session="effect-wire",members={"100","200"}}, {
    boundary=function()return boundary end,offer=function()return offer end,
    fingerprint=function(_,v)return authority_digest(v)end,persist=function()end})
  local endpoint=setmetatable({},E.prototype);endpoint:____constructor(authority)
  local bus={now=0,owner="",members={["100"]="",["200"]=""},calls=0}
  local function make(self)
    local m=setmetatable({},C.prototype)
    m:____constructor({lobby="1000",owner="100",self=self,session="effect-wire",epoch="e"..self,members={"100","200"}}, {
      now=function()return bus.now end,
      read=function()return {lobby="1000",owner="100",self=self,ownerValue=bus.owner,members={{id="100",value=bus.members["100"]},{id="200",value=bus.members["200"]}}}end,
      writeMember=function(_,v)bus.members[self]=v;return true end,writeOwner=function(_,v)bus.owner=v;return true end,
      encode=function(_,v)return mail_encode(v)end,decode=function(_,v)return mail_decode(v)end,
      bytes=function(_,v)return #v end,fingerprint=function(_,v)return authority_digest(v)end,
      dispatch=function(_,sender,epoch,id,q)bus.calls=bus.calls+1;return endpoint:dispatch(sender,epoch,id,q)end,
      fail=function(_,reason)error(reason)end})
    return m
  end
  local host,guest=make("100"),make("200")
  local function rounds()for i=1,10 do bus.now=bus.now+1;host:tick();guest:tick()end end
  local function send(peer,id,q)
    peer:request(id,q);rounds();local r=peer:result(id);assert(r.state=="reply",mail_encode(peer:snapshot()));return r.value
  end
  rounds()
  local query={op="buy",product="attack",revision=offer.revision,layer=1,token=8,weapon=2,balance=150}
  host:request("host-buy",query);guest:request("guest-buy",query);rounds()
  local granted=host:result("host-buy").value
  assert(granted.ok and not guest:result("guest-buy").value.ok and #authority:snapshot().orders==1)
  assert(granted.permit.price==30 and not granted.permit.charged and not granted.permit.offer)
  local p=granted.permit
  local receipt={op="report",order=p.id,serial=1,state="reserved",charged=false,revision=p.revision,nativeOrder=p.nativeOrder,
    verification="attribute",status="not-applied",evidence=string.rep('c',64),message="reserved"}
  assert(send(host,"reserved",receipt).ok);authority:lockWave(1,8)
  receipt.serial=2;receipt.state="active";receipt.charged=true;receipt.status="applied"
  assert(send(host,"active",receipt).ok)
  local h=send(host,"host-status",{op="status",layer=1,token=8}).preparation
  assert(not send(host,"old-token",{op="prepared",layer=1,token=7,digest=h.digest}).ok)
  assert(send(host,"host-ready",{op="prepared",layer=1,token=8,digest=h.digest}).ok)
  assert(not pcall(function()authority:releaseWave(1)end))
  local g=send(guest,"guest-status",{op="status",layer=1,token=8}).preparation
  assert(send(guest,"guest-ready",{op="prepared",layer=1,token=8,digest=g.digest}).ok)
  authority:releaseWave(1)
  assert(send(guest,"released",{op="status",layer=1,token=8}).preparation.released)
end''')(authority.EffectAuthority, wire.EffectEndpoint, mailbox.PeerMailbox, program)
print('PASS Lua 5.4: integrated effect endpoint and two peers, last team slot, native receipt and exact all-peer readiness (simulated transport)')

participant = lua.execute(bundle.replace(entry, 'return require("src.core.effect_participant")'))
lua.eval('''function(Client,Orders,Mailbox,P)
  local offer={id="attack",name="攻击强化",price=30,enabled=true,revision=string.rep('a',64),definition=P.definition,
    effect={id="attack.flat",version=P.definition.version,parameters={amount=10}},groupRule={policy="add",cap=30},
    conditions={phases={"Selecting"},fromLayer=1,toLayer=99,weapons={},exclusiveGroups={},limit={count=1,scope="teamRun"}}}
  local bus={now=0,owner="",members={["100"]="",["200"]=""}}
  local function make(self)
    local state={wallet=150,stat=0,applications=0,writes=0,boundary={layer=1,token=1,phase="Selecting",accepting=true}}
    local charged={}
    local api={check_stat=function()return nil end,
      add_stat=function(_,amount)local before=state.stat;state.stat=state.stat+amount;state.applications=state.applications+1;
        return {status="applied",verification="attribute",message="实际字段核验",before=before,after=state.stat,handle={before=before,after=state.stat}}end,
      inspect_stat=function(r)return r end,restore_stat=function(r)state.stat=r.handle.before;return {status="applied",verification="attribute",message="实际移除核验"}end}
    local engine=setmetatable({},Orders.prototype)
    engine:____constructor({balance=function()return state.wallet end,
      charge=function(_,o)if not charged[o.id]then state.wallet=state.wallet-o.offer.price;charged[o.id]=true end end,
      check=function(_,o)return P.check(api,o.effect.parameters)end,
      apply=function(_,o)return P.apply(api,o.offer.effect.parameters)end,
      inspect=function(_,o)return P.inspect(api,o.offer.effect.parameters,o.evidence)end,
      remove=function(_,o)return P.remove(api,o.offer.effect.parameters,o.evidence)end,
      fingerprint=function(_,v)return authority_digest(v)end,persist=function()end})
    local identity={lobby="1000",owner="100",self=self,session="effect-client",epoch="e"..self,members={"100","200"}}
    local client=setmetatable({},Client.prototype)
    client:____constructor(identity,{
      now=function()return bus.now end,boundary=function()return state.boundary end,
      context=function()return {run=identity.session,wave=identity.session.."/wave-1",layer=1,phase="Selecting",player=self,team={"100","200"},weapon=2}end,
      offer=function()return offer end,balance=function()return state.wallet end,orders=function()return engine:snapshot()end,
      reserve=function(_,o,c,id)return engine:reserve(o,o.revision,c,id)end,cancel=function(_,id)return engine:cancel(id,self)end,
      fingerprint=function(_,v)return authority_digest(v)end,persist=function()state.writes=state.writes+1 end,
      network=function(_,dispatch,fail)
        local m=setmetatable({},Mailbox.prototype)
        m:____constructor(identity,{
          now=function()return bus.now end,
          read=function()return {lobby="1000",owner="100",self=self,ownerValue=bus.owner,members={{id="100",value=bus.members["100"]},{id="200",value=bus.members["200"]}}}end,
          writeMember=function(_,v)bus.members[self]=v;return true end,writeOwner=function(_,v)bus.owner=v;return true end,
          encode=function(_,v)return mail_encode(v)end,decode=function(_,v)return mail_decode(v)end,
          bytes=function(_,v)return #v end,fingerprint=function(_,v)return authority_digest(v)end,dispatch=dispatch,fail=fail})
        return m
      end})
    return {client=client,engine=engine,state=state}
  end
  local host,guest=make("100"),make("200")
  local function tick()bus.now=bus.now+1;host.client:tick();guest.client:tick()end
  local function until_(predicate)
    for i=1,160 do if predicate()then return end;tick()end
    error(mail_encode(host.client:diagnostic())..mail_encode(guest.client:diagnostic()))
  end
  until_(function()return host.client:diagnostic().ready and guest.client:diagnostic().ready end)
  guest.client:submit("buy","buy","attack",offer.revision)
  assert(#guest.engine:snapshot()==0 and guest.state.stat==0)
  until_(function()return guest.client:result("buy")~=nil end)
  assert(guest.client:result("buy").ok and guest.engine:available("200")==120 and guest.state.wallet==150 and host.state.wallet==150)
  assert(host.client:lockWave().ok);host.state.boundary.accepting=false;guest.state.boundary.accepting=false
  until_(function()return guest.client:lockWave().ok end)
  guest.engine:lockForNative("effect-client","effect-client/wave-1");guest.engine:lockWave("effect-client","effect-client/wave-1")
  guest.client:nativePrepared();for i=1,15 do tick()end;assert(not guest.client:released())
  host.client:nativePrepared();until_(function()return host.client:released()and guest.client:released()end)
  assert(guest.state.wallet==120 and guest.state.stat==10 and guest.state.applications==1)
  guest.engine:endWave("effect-client","effect-client/wave-1")
  until_(function()return host.client:snapshot().authority.orders[1].state=="ended"end)
  assert(guest.state.stat==0 and host.state.stat==0 and host.state.wallet==150)
  host.state.boundary.layer=2;host.state.boundary.token=2
  for i=1,25 do tick()end
  assert(not host.client:diagnostic().closed and not guest.client:diagnostic().closed,"stale reads must not close the next layer")
  guest.state.boundary.layer=2;guest.state.boundary.token=2
  until_(function()local p=guest.client:diagnostic().preparation;return p and p.layer==2 and p.token==2 end)
end''')(participant.EffectParticipant, modules.EffectOrders, mailbox.PeerMailbox, program)
print('PASS Lua 5.4: buyer journal -> host permit -> local real effect -> all-peer release -> verified cleanup (simulated native fields/transport)')
