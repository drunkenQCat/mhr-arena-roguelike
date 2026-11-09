"""Execute the built core under Lua 5.4 without loading REFramework or deploying.

Requires: python -m pip install lupa
Run after building: python scripts/check-lua-runtime.py
"""
import json
from pathlib import Path

from lupa.lua54 import LuaRuntime

ROOT = Path(__file__).resolve().parent.parent
original_bundle = (ROOT / "reframework/autorun/mhw_rogue.lua").read_text(encoding="utf-8")
bundle = original_bundle
entry = 'local ____entry = require("src.game.main", ...)\nreturn ____entry'
assert bundle.count(entry) == 1, "Bundle entry changed; update this runtime harness"
# Keep the actual modules/lualib; replace only the host-specific entry in memory.
bundle = bundle.replace(entry, '''return {
  Rng = require("src.core.rng").Rng,
  RunCore = require("src.core.run_core").RunCore,
  RunSession = require("src.core.run_session").RunSession,
  catalog = require("src.game.default_config").monsterCatalog,
  validateConfig = require("src.core.config").validateConfig
}''')
lua = LuaRuntime(unpack_returned_tuples=True)
modules = lua.execute(bundle)
new = lua.eval('''function(Class, ...)
  local instance = setmetatable({}, Class.prototype)
  instance:____constructor(...)
  return instance
end''')


def reference_rng(seed, count):
    """Independent uint32 mulberry32 oracle, with the documented ten warm-up draws."""
    state = seed if seed != 0 else 0x9E3779B9
    output = []
    for i in range(count + 10):
        state = (state + 0x6D2B79F5) & 0xFFFFFFFF
        value = ((state ^ (state >> 15)) * (state | 1)) & 0xFFFFFFFF
        value ^= (value + (((value ^ (value >> 7)) * (value | 61)) & 0xFFFFFFFF)) & 0xFFFFFFFF
        if i >= 10:
            output.append((value ^ (value >> 14)) & 0xFFFFFFFF)
    return output


for seed in [0, 1, 42, -1, 0x9E3779B9, 0xFFFFFFFF]:
    rng = new(modules.Rng, seed)
    actual = [rng.nextUint(rng) for _ in range(100)]
    assert actual == reference_rng(seed, 100), f"Lua RNG sequence differs for seed {seed}"

raw = json.loads((ROOT / "data/rogue_config.json").read_text(encoding="utf-8"))
config = modules.validateConfig(None, lua.table_from(raw, recursive=True))
core = new(modules.RunCore, config, 42)
armor = config.armorOptions[1]
assert core.startRun(core, armor).ok
core.state.layer = 16
option = core.generateChoices(core, 4)[1]
assert option.rewardPt == 374 and option.rewardMul == 1.7
assert abs(option.hpMul - 2.97) < 1e-9
assert abs(option.dmgMul - 1.595) < 1e-9
assert core.pickChoice(core, 0).ok and core.killWave(core).ok
assert core.state.wallet.pt == 524
core.cart(core)
core.cart(core)
core.cart(core)
assert core.state.phase == "GameOver"
assert core.startRun(core, armor).ok
assert core.state.cartsLeft == 3 and core.state.activeWave is None
assert len(core.state.killedUltimates) == 0
assert len(core.state.currentChoices) == 0
assert core.state.wallet.pt == 150

for problem in ["negative price", "missing unlock rules"]:
    invalid = json.loads(json.dumps(raw))
    if problem == "negative price":
        invalid["Shop"][0]["Price"] = -100
    else:
        del invalid["UnlockChain"]
    try:
        modules.validateConfig(None, lua.table_from(invalid, recursive=True))
    except Exception:
        pass
    else:
        raise AssertionError(f"Lua accepted invalid config: {problem}")

print("PASS Lua 5.4: 600 RNG draws, AU/multiplayer/restart flow, invalid configs")

# Execute the emitted session state machine, not a Python/JS reimplementation.
lua.eval('''function(modules, config)
  assert(config.runtime.route == 'inPlace')
  -- Exercise the explicit fallback route independently of the new default.
  config.runtime.route = 'reentry'
  config.runtime.carveSeconds = 2
  config.runtime.campDwellSeconds = 1
  local core = setmetatable({}, modules.RunCore.prototype)
  core:____constructor(config, 42)
  local port = { reading = { time = 0, quest = nil, players = {
      {id = 0, position = {x = 10, y = 20, z = 30}} },
      enemies = {}, deaths = 0, online = false, canPost = true }, posts = 0, finished = 0 }
  function port:ready() return true end
  function port:read() return self.reading end
  function port:publish(plan, inPlace) self.plan = plan end
  function port:policy(plan, hold) self.held = hold end
  function port:post(id) self.posts = self.posts + 1 end
  function port:cancelPost() end
  function port:postingError() return nil end
  function port:takeDeaths() return {} end
  function port:report(event, detail) end
  function port:finish(failed)
    self.finished = self.finished + 1
    self.reading.quest.playing = false
    self.reading.quest.status = 'success'
  end
  local session = setmetatable({}, modules.RunSession.prototype)
  session:____constructor(core, modules.catalog, port)
  assert(session:start(config.armorOptions[1], false).ok)
  assert(#core.state.currentChoices == config.choiceCount)
  local choice
  for _, option in ipairs(core.state.currentChoices) do
    if #option.monsters == 2 then choice = option.index end
  end
  assert(choice ~= nil and session:choose(choice).ok)
  local function tick(time) port.reading.time = time; session:tick() end
  port.reading.quest = { id = config.quest.id, unique = 1, playing = true, status = 'play' }
  port.reading.canPost = false
  tick(1)
  assert(session.stage == 'Combat')
  local ids = session.plan.monsterIds
  local reward = session.plan.wave.rewardPt
  port.reading.deaths = 1
  port.reading.enemies = {{uid = 1, typeId = ids[1], dead = true, captured = false}}
  tick(2)
  port.reading.enemies = {}
  tick(3)
  assert(session.stage == 'Combat' and core.state.wallet.pt == 150)
  port.reading.enemies = {{uid = 2, typeId = ids[2], dead = false, captured = false}}
  tick(4)
  port.reading.enemies[1].dead = true
  tick(5)
  assert(session.stage == 'Carve' and core.state.wallet.pt == 150 + reward)
  tick(7); tick(8)
  assert(session.stage == 'Returning' and port.finished == 1)
  port.reading.quest = nil; port.reading.canPost = true; port.reading.enemies = {}
  tick(9)
  assert(session.stage == 'Selecting' and core.state.layer == 2 and core.state.cartsLeft == 2)
  assert(session:choose(0).ok and port.posts == 2)
  assert(session.plan.layer == 2)
end''')(modules, config)
print("PASS Lua 5.4: compiled M2 two-monster gap, one-time reward, camp gate and native reentry")

# Host API stubs check the complete autorun entry and callback registration without a game.
host = LuaRuntime(unpack_returned_tuples=True)
host.execute('''
  callbacks = {}; reports = {}
  fs = {read = function() return "" end, glob = function() return {} end}
  log = {info = function() end, warn = function() end, error = function() end}
  json = {load_file = function() return nil end,
    dump_file = function(path, data) reports[path] = data; return true end}
  thread = {get_hook_storage = function() return {} end}
  sdk = {PreHookResult = {CALL_ORIGINAL = 0, SKIP_ORIGINAL = 1}}
  save_hooks = {}; native_save = {get_SaveState=1,get_LastSaveResult=2,get_LastSaveFailed=false,get_SaveSlotLast=1}
  sdk.find_type_definition = function(name)
    if name ~= 'via.storage.saveService.SaveService' and name ~= 'snow.SnowSaveService' then return nil end
    return {get_method=function(_, method) return {name=name..'.'..method,
      call=function() return native_save[method] end} end}
  end
  sdk.hook = function(method, pre, post) save_hooks[method.name]={pre=pre,post=post} end
  re = {on_frame = function(cb) callbacks.frame = cb end,
    on_draw_ui = function(cb) callbacks.ui = cb end,
    on_script_reset = function(cb) callbacks.reset = cb end}
  imgui = {tree_node = function() return false end}
''')
host.execute(original_bundle)
assert host.globals().reports["mhw_rogue_boot.json"] is not None, str(host.globals().reports["mhw_rogue_error.json"])
assert host.globals().reports["mhw_rogue_boot.json"].ok is True
assert host.globals().reports["mhw_rogue_boot.json"].route == "inPlace"
assert host.globals().reports["mhw_rogue_error.json"] is None
assert host.globals().callbacks.frame is not None
host.globals().callbacks.ui()
host.globals().callbacks.reset()
print("PASS Lua 5.4: full autorun bootstrap and UI/reset callback signatures")

# Reproduce REFramework's bare-name overload ambiguity against the emitted Lua.
host.execute('''
  item_count = 0; item_writes = 0
  local signature = "tryAddGameItem(snow.data.ContentsIdSystem.ItemId, System.Int32)"
  local pouch = {}
  function pouch:get_type_definition()
    return {get_method = function(_, name) if name == signature then return {} end end}
  end
  function pouch:call(name, id, count)
    if name == "findInventoryData" then
      if item_count == 0 then return nil end
      return {call = function() return item_count end}
    end
    if name == "canAddItem" then return true end
    if name == "tryAddGameItem" then return nil end -- wrong overload: warns, no exception
    if name == signature then
      assert(id == 68157449 and count == 1, "wrong item or quantity sent to native method")
      item_count = item_count + count; item_writes = item_writes + 1
      return nil -- real method returns void
    end
    error("Unexpected pouch method: " .. name)
  end
  sdk.get_managed_singleton = function(name)
    if name == "snow.data.DataManager" then return {get_field = function() return pouch end} end
    if name == "snow.QuestManager" or name == "snow.stage.StageManager" then
      return {call = function() return false end}
    end
    if name == "snow.gui.GuiManager" then
      return {call = function(_, method) return method == "IsCanInvokeQuestBoard" end}
    end
  end
''')
grant_module = host.execute(original_bundle.replace(entry, 'return require("src.game.item_grant")'))
for expected in (1, 2):
    report = grant_module.grantItem(None, "dust_life", 1)
    assert report.granted and report.before == expected - 1 and report.after == expected
assert host.globals().item_writes == 2
print("PASS Lua 5.4: explicit native grant overload, first stack and stacking, void return readback")

# The equipment gate must invoke static reflection with a nil instance and the
# complete overload, including after a temporarily unavailable native table.
host.execute('''
  catalog_api=true;catalog_valid=true;catalog_present=true;catalog_lookups=0;catalog_actual=nil
  sdk.find_type_definition=function(name)
    if not catalog_api or name~="snow.data.DataShortcut" then return nil end
    return {get_method=function(_,name)
      assert(name=="isValid(snow.data.DataDef.PlArmorId)" or name=="getArmorBaseData(snow.data.DataDef.PlArmorId)")
      return {call=function(_,instance,id)
        assert(instance==nil and type(id)=="number", "wrong static reflection call convention")
        if name:sub(1,8)=="isValid(" then return catalog_valid end
        catalog_lookups=catalog_lookups+1
        return catalog_present and {call=function(_,method)
          assert(method=="get_Id");return catalog_actual or id
        end} or nil
      end}
    end}
  end
''')
catalog_module = host.execute(original_bundle.replace(entry, 'return require("src.game.equipment_catalog")'))
assert catalog_module.equipmentUnavailableReason(None,"armor",202375177) is None
host.globals().catalog_actual = 202375178
assert catalog_module.equipmentUnavailableReason(None,"armor",202375177) is not None
host.globals().catalog_actual = None
host.globals().catalog_valid = False
assert catalog_module.equipmentUnavailableReason(None,"armor",0x0c1fffff) is not None
assert host.globals().catalog_lookups == 2
host.globals().catalog_valid = True
host.globals().catalog_present = False
assert catalog_module.equipmentUnavailableReason(None,"armor",202375177) is not None
host.globals().catalog_api = False
assert catalog_module.equipmentUnavailableReason(None,"armor",202375177) is not None
host.globals().catalog_api = True
host.globals().catalog_present = True
assert catalog_module.equipmentUnavailableReason(None,"armor",202375177) is None
print("PASS Lua 5.4: installed equipment range/data checks, static reflection ABI and transient recovery")


# The emitted multiplayer modules must run without JS globals (JSON/Date/Array).
# Two isolated business peers share only the same bounded Steam-value test bus.
import hashlib
multi = LuaRuntime(unpack_returned_tuples=True)
def wire_value(value):
    if hasattr(value, "items"):
        entries = list(value.items())
        if entries and all(isinstance(k, int) for k, _ in entries):
            return [wire_value(value[i]) for i in range(1, len(entries) + 1)]
        return {str(k): wire_value(v) for k, v in entries}
    return value
multi.globals().wire_dump = lambda value, *_: json.dumps(wire_value(value), ensure_ascii=False, separators=(",", ":"))
multi.globals().wire_load = lambda text: multi.table_from(json.loads(text), recursive=True)
multi.globals().wire_hash = lambda text: hashlib.sha256(text.encode("utf-8")).hexdigest()
multi.execute('''
  clock=100; os.time=function() return clock end
  log={info=function() end,warn=function() end,error=function() end}
  json={dump_string=wire_dump,load_string=wire_load}
  thread={get_hook_storage=function() return {} end}
  sdk={PreHookResult={CALL_ORIGINAL=0,SKIP_ORIGINAL=1}}
  re={}; fs={}; imgui={}
''')
mpmods = multi.execute(original_bundle.replace(entry, """
____moduleCache["src.game.multiplayer_scope"] = {value={multiplayerScope=function() return true end}}
return {RunCore=require("src.core.run_core").RunCore,
 RunSession=require("src.core.run_session").RunSession,
 MultiplayerRun=require("src.game.multiplayer_run").MultiplayerRun,
 MultiplayerConfig=require("src.game.multiplayer_config").MultiplayerConfig,
 NativeRuntime=require("src.game.native_runtime").NativeRuntime,
 canonical=require("src.game.wire_canonical").canonical,
 makeQuestPlan=require("src.core.quest_plan").makeQuestPlan,
 validateConfig=require("src.core.config").validateConfig,
 catalog=require("src.game.default_config").monsterCatalog}
"""))
multi.globals().mpmods = mpmods
multi.globals().raw_config = multi.table_from(raw, recursive=True)
multi.execute('''
  assert(JSON==nil and Date==nil and Array==nil)
  local m=mpmods
  local function new(C,...) local o=setmetatable({},C.prototype);o:____constructor(...);return o end
  bus={plan="",acks={}}
  local function peer(self)
    local cfg=m.validateConfig(nil,raw_config);cfg.quest.id=900103
    cfg.runtime.carveSeconds=1;cfg.runtime.campDwellSeconds=0
    local core=new(m.RunCore,cfg,42)
    local p={reading={time=clock,quest={id=900103,unique=7,playing=true,status="play"},
      online=true,canPost=false,deaths=0,enemies={},players={
      {id=0,position={x=10,y=20,z=30}},{id=1,position={x=10,y=20,z=30}}}}}
    function p:now() return clock end
    function p:ready() return true end
    function p:read() self.reading.time=clock;return self.reading end
    function p:publish(plan) self.published=plan end
    function p:policy() end
    function p:cancelPost() end
    function p:postingError() return nil end
    function p:takeDeaths() return {} end
    function p:report() end
    function p:finish() error("unexpected native finish") end
    function p:multiplayerRole() return self.run and self.run.role end
    function p:multiplayerValid() return self.run and self.run:valid() end
    function p:multiplayerCanChoose() return self.run and self.run:canChoose() end
    function p:partySize() return self.run and self.run:partySize() end
    local s=new(m.RunSession,core,m.catalog,p)
    local net={steam_digest=wire_hash,steam_plan=function(_,text) assert(#text<=2048);bus.plan=text;return true end,
      steam_ack=function(_,text) bus.acks[self]=text;return true end,
      steam_snapshot=function() return {lobbies={{id="l",owner="h",self=self,plan=bus.plan,
        members={{id="h",ack=bus.acks.h or ""},{id="g",ack=bus.acks.g or ""}}}}} end}
    local runtime={publish=function(_,plan) p.published=plan end,report=function() end,
      mirrorCartRestore=function() error("unexpected late native cart write") end}
    local run=new(m.MultiplayerRun,{lobby="l",owner="h",self=self,session="s",members={"h","g"}},cfg,m.catalog,s,runtime,function() return p.busy or false end,net)
    p.run=run
    local w={index=0,mode="single",typeTag="A",label="entry",monsters={"Great Izuchi"},tier="weak",hpMul=1,dmgMul=1,rewardMul=0,rewardPt=0}
    assert(s:adoptMultiplayerEntry(m.makeQuestPlan(nil,cfg,m.catalog,w,1,1,false)).ok)
    s:tick()
    return {s=s,run=run,core=core,p=p}
  end
  local h,g=peer("h"),peer("g")
  assert(h.run:partySize()==2 and g.run:partySize()==2)
  local nativeRoster={partySize=function(self) assert(self~=nil);return 4 end}
  local mockReads=0
  local nativeFacade={multiplayer=nativeRoster,partySizeSource=function() mockReads=mockReads+1;return 1 end}
  assert(m.NativeRuntime.prototype.partySize(nativeFacade)==4 and mockReads==0)
  nativeFacade.multiplayer=nil
  assert(m.NativeRuntime.prototype.partySize(nativeFacade)==1 and mockReads==1)
  local function tick() clock=clock+1;h.s:tick();h.run:tick();g.s:tick();g.run:tick() end
  local function clear()
    h.p.reading.enemies={}
    for i,id in ipairs(h.s.plan.monsterIds) do h.p.reading.enemies[i]={uid=h.core.state.layer*100+i,typeId=id,dead=true,captured=false} end
    tick();tick();tick();tick()
  end
  tick();clear()
  assert(h.s.stage=="Selecting" and g.s.stage=="Selecting",g.s.message)
  assert(h.s:canChoose() and not g.s:canChoose())
  assert(h.s:choose(1).ok);h.p.reading.enemies={};tick();tick()
  assert(g.p.published.token==h.s.plan.token)
  local ticket={token=h.s.plan.token,ordinal=0,type=h.s.plan.monsterIds[1],slot=2,id=3,uid=300}
  h.run:staged(ticket);assert(not h.run:activate(ticket));tick()
  g.run:staged(ticket);tick();tick();assert(h.run:activate(ticket))
  assert(not h.run:canStage());tick();assert(g.run:activate(ticket));tick();tick();assert(h.run:canStage())
  g.core.state.wallet.pt=g.core.state.wallet.pt-15
  clear();local expected=150-15+h.s.plan.wave.rewardPt
  assert(g.core.state.wallet.pt==expected,g.s.message)
  tick();assert(g.core.state.wallet.pt==expected)
  assert(g.core.state.layer==3)
  -- A terminal frame wins over an unknown local delivery without performing
  -- late loot/cart writes or fabricating this engine's native failure result.
  g.p.busy=true
  local pendingBefore=#g.s.pendingSupplies
  local guards=0
  function g.p:guardFailure(expected) assert(expected.id==900103 and expected.unique==7);guards=guards+1 end
  function g.p:policy(_,hold) if not hold then assert(guards==1) end end
  function g.p:ultimateDrop() error("unexpected terminal equipment grant") end
  function h.p:finish(failed,expected) assert(failed and expected.id==900103 and expected.unique==7) end
  clock=clock+1;h.s:stop();h.run:tick()
  local terminal=wire_load(bus.plan)
  terminal.earned=terminal.earned+80;terminal.w[4]="ultimate";terminal.cartUsed=true
  bus.plan=wire_dump(terminal);g.run:tick()
  assert(g.s.stage=="Finished" and not g.run:valid() and guards==1)
  assert(g.core.state.wallet.pt==expected+80 and #g.s.pendingSupplies==pendingBefore)
  assert(g.s:runSummary().ending.intent=="stopped" and g.s:runSummary().ending.native==nil)
  assert(not string.find(bus.acks.g or "","R4ERR|",1,true))
''')
print("PASS Lua 5.4: two-peer staging/rewards, wallet isolation and terminal priority over unresolved delivery")

# The live adapter must compare the caller's authorized instance before pinning
# clear or queueing completion, then compare the copied identity again in update.
multi.execute('''
  local q={id=900103,unique=13,writes=0}
  function q:call(name)
    if name=="get_ActiveQuestNo" then return self.id end
    if name=="getActiveQuestUniqueNo" then return self.unique end
    if name=="isActiveQuest" or name=="isPlayQuest" then return true end
    if name=="setQuestFail" or name=="setQuestClear" then self.writes=self.writes+1 end
  end
  function q:get_field() return 2 end
  sdk.get_managed_singleton=function(name) if name=="snow.QuestManager" then return q end end
  local native=setmetatable({cfg={quest={id=900103}}},mpmods.NativeRuntime.prototype)
  local expected={id=900103,unique=12}
  assert(not pcall(function() native:guardFailure(expected) end))
  assert(not pcall(function() native:finish(true,expected) end))
  assert(not pcall(function() native:finish(false,expected) end))
  assert(native.failedEnding==nil and native.pendingFinish==nil and q.writes==0)
  assert(not pcall(function() native:finish(false,nil) end))
  q.unique=-12;expected.unique=-12
  native:finish(true,expected);expected.unique=99
  native:finishInNativeUpdate();assert(q.writes==1 and native.failedEnding.unique==-12)
  native:finish(true,{id=900103,unique=-12});q.unique=99
  native:finishInNativeUpdate();assert(q.writes==1 and native.pendingFinish==nil)
''')
print("PASS Lua 5.4: native completion uses explicit immutable identity at queue and execution")

# Exercise the emitted configuration protocol using the exact C-module noSelf
# conventions. This is a protocol test, not proof that production is wired yet.
multi.execute('''
  assert(JSON==nil and Date==nil and Array==nil)
  local m=mpmods
  local function new(C,...) local o=setmetatable({},C.prototype);o:____constructor(...);return o end
  local bus={control='',payload='',complete=false,acks={}}
  local ids={'h','g','g2','g3'}
  local function peer(id)
    local p={rules={price=10,hp=1},wallet=123,applied=0,saved=0,finished=false}
    local hooks={}
    function hooks:boundary() return {token=9,layer=2,ready=true} end
    function hooks:currentHash() return wire_hash(m.canonical(nil,p.rules)) end
    function hooks:validate(text)
      local value=wire_load(text);assert(value.hp>0 and value.price>=0)
      return {value=value,effectiveHash=wire_hash(m.canonical(nil,value))}
    end
    function hooks:apply(value) p.rules=value;p.applied=p.applied+1 end
    function hooks:finish(value) p.saved=p.saved+1 end
    function hooks:restore() p.rules={price=10,hp=1} end
    function hooks:fail(reason) error('unexpected config failure on '..id..': '..reason..'; '..wire_dump(p.sync:snapshot())..'; '..bus.control) end
    local net={steam_digest=wire_hash,
      steam_config_payload=function(_,text) bus.payload=text;return true end,
      steam_config_control=function(_,text) bus.control=text;return true end,
      steam_config_ack=function(_,text) bus.acks[id]=text;return true end,
      steam_snapshot=function()
        local members={}
        for i,member in ipairs(ids) do members[i]={id=member,ack='gameplay-unchanged',configAck=bus.acks[member] or ''} end
        return {lobbies={{id='l',owner='h',self=id,plan='gameplay-unchanged',members=members,
          config={control=bus.control,payload=bus.payload,digest=wire_hash(bus.payload),complete=bus.complete}}}}
      end}
    p.sync=new(m.MultiplayerConfig,{lobby='l',owner='h',self=id,session='s',members=ids},hooks,net)
    return p
  end
  local peers={};for i,id in ipairs(ids) do peers[i]=peer(id) end
  local serial=peers[1].sync:propose(wire_dump({price=15,hp=1.5}))
  local function tick(n) for _=1,n do clock=clock+1;for _,p in ipairs(peers) do p.sync:tick() end end end
  tick(4);for _,p in ipairs(peers) do assert(p.applied==0 and p.wallet==123) end
  bus.complete=true;tick(10)
  for _,p in ipairs(peers) do assert(p.applied==1 and p.saved==1 and p.rules.price==15 and not p.sync:busy() and p.wallet==123) end
  assert(peers[1].sync:result(serial).status=='applied')
  tick(5);for _,p in ipairs(peers) do assert(p.applied==1 and p.saved==1) end
''')
print("PASS Lua 5.4: four-peer config barrier, incomplete payload, noSelf ABI, once-only apply and wallet preservation")

# Execute the emitted recovery writer with Lua C-module calling conventions.
# Never substitute an unsafe json.dump_file fallback when a DLL is older/missing.
journal = LuaRuntime(unpack_returned_tuples=True)
journal.globals().journal_dump = lambda value, *_: json.dumps(wire_value(value), ensure_ascii=False, separators=(",", ":"))
journal.globals().journal_load = lambda text: journal.table_from(json.loads(text), recursive=True)
journal.execute("""
  sdk={PreHookResult={CALL_ORIGINAL=0,SKIP_ORIGINAL=1}};re={};thread={};log={};imgui={}
  disk='{"active":true,"original":1}';writer_exists=true;write_ok=true;readback_ok=true
  fs={read=function() return disk end,glob=function() return {'mhw_rogue_startup_state.json'} end}
  json={dump_string=journal_dump,load_string=journal_load,dump_file=function() error('unsafe fallback') end}
  package.preload.webconsole=function()
    return {write_recovery=writer_exists and function(name,text)
      assert(name=='mhw_rogue_startup_state.json' and type(text)=='string')
      if not write_ok then return false end
      disk=readback_ok and text or 'wrong';return true
    end or nil}
  end
""")
journal.globals().journal_module = journal.execute(original_bundle.replace(entry, 'return require("src.game.recovery_journal")'))
journal.execute("""
  local m=journal_module;local f='mhw_rogue_startup_state.json'
  writer_exists=false;package.loaded.webconsole=nil
  assert(not m.writeRecoveryRecord(nil,f,{active=false}) and disk:find('original'))
  writer_exists=true;write_ok=false;package.loaded.webconsole=nil
  assert(not m.writeRecoveryRecord(nil,f,{active=false}) and disk:find('original'))
  write_ok=true;readback_ok=false;assert(not m.writeRecoveryRecord(nil,f,{active=false}))
  readback_ok=true;assert(m.writeRecoveryRecord(nil,f,{active=true,original=2}))
  assert(m.readRecoveryRecord(nil,f).original==2)
""")
print("PASS Lua 5.4: atomic recovery writer arguments, missing DLL, failed write and exact readback")

# Ending intent is business metadata. Only local readings establish native results,
# including a result arriving after Finished (the normal asynchronous return path).
ending_config = modules.validateConfig(None, lua.table_from(raw, recursive=True))
lua.eval('''function(m, config)
  local function new(Class,...) local o=setmetatable({},Class.prototype);o:____constructor(...);return o end
  for _,mode in ipairs({'stopped','carts-exhausted'}) do
    local clock=0;local finishes=0
    local reading={time=0,online=false,canPost=true,deaths=0,enemies={},players={{id=0,position={x=10,y=20,z=30}}}}
    local port={ready=function() return true end,read=function() return reading end,
      publish=function() end,policy=function() end,post=function() end,cancelPost=function() end,
      postingError=function() end,takeDeaths=function() return {} end,report=function() end,
      finish=function(_,failed,expected) assert(failed and expected.id==reading.quest.id and expected.unique==reading.quest.unique);finishes=finishes+1 end}
    local session=new(m.RunSession,new(m.RunCore,config,42),m.catalog,port)
    local function tick() clock=clock+1;reading.time=clock;session:tick() end
    assert(session:start(config.armorOptions[1],true).ok)
    reading.quest={id=config.quest.id,unique=7,status='play',playing=true};reading.canPost=false;tick()
    if mode=='stopped' then session:stop() else
      for deaths=1,3 do reading.deaths=deaths;tick() end
    end
    local summary=session:runSummary()
    assert(summary.ending.intent==mode and summary.ending.native==nil and finishes==1)
    reading.quest.status='failed';reading.quest.playing=false;reading.quest.unique=8;tick()
    assert(session:runSummary().ending.native==nil)
    reading.quest.unique=7;tick();summary=session:runSummary()
    assert(summary.ending.native.status=='failed' and summary.ending.native.deaths==reading.deaths)
    summary.ending.native.status='success';assert(session:runSummary().ending.native.status=='failed')
    reading.quest.status='return';tick();assert(session:runSummary().ending.native.status=='failed')
    reading.quest=nil;tick();assert(session:runSummary().ending.native.status=='failed' and finishes==1)
  end
end''')(modules, ending_config)
print("PASS Lua 5.4: stop vs exhausted carts, delayed local failure, instance binding and preserved result")

# Exercise a real emitted ShopWindow transaction: one write, ambiguous readback,
# no retry/refund, then retire the lock only at the restored-village boundary.
host.globals().shop_modules = host.execute(original_bundle.replace(entry, '''return {
  ShopWindow=require("src.game.shop_window").ShopWindow,
  RunCore=require("src.core.run_core").RunCore,
  validateConfig=require("src.core.config").validateConfig,
  raw=require("src.game.default_config").defaultConfig
}'''))
host.execute('''
  local count,writes,wrongRead=2,0,false
  local signature="tryAddGameItem(snow.data.ContentsIdSystem.ItemId, System.Int32)"
  local slot={call=function() if wrongRead then wrongRead=false;return count+1 end;return count end}
  local pouch={get_type_definition=function()return {get_method=function()return {} end}end}
  function pouch:call(name,id,n)
    if name=="findInventoryData"then return slot end
    if name=="canAddItem"then return true end
    assert(name==signature and id==68157449 and n==1)
    count=count+1;writes=writes+1;wrongRead=true
  end
  sdk.get_managed_singleton=function(name)
    if name=="snow.data.DataManager"then return {get_field=function()return pouch end}end
    return {call=function(_,method)return method=="IsCanInvokeQuestBoard"end}
  end
  local m=shop_modules
  local function new(Class,...)local o=setmetatable({},Class.prototype);o:____constructor(...);return o end
  local cfg=m.validateConfig(nil,m.raw)
  cfg.shop={{id="dust_life",name="test",category="test",price=10,cap=10,mode="perUnit"}}
  local core=new(m.RunCore,cfg,42);assert(core:startRun(cfg.armorOptions[1]).ok);core:generateChoices(1)
  local shop=new(m.ShopWindow,core,function()return true end)
  assert(shop:requestPurchase("dust_life").ok);shop:tick()
  assert(shop.busy and shop.lastTransaction.status=="uncertain" and count==3 and writes==1 and core.state.wallet.pt==140)
  assert(not shop:requestPurchase("dust_life").ok)
  local village={canPost=true,players={{id=0,position={x=1,y=2,z=3}}},enemies={},deaths=0,time=10,online=true}
  assert(not shop:retireAfterRestore("Selecting",false,village))
  assert(not shop:retireAfterRestore("Finished",true,village) and shop.busy)
  assert(shop:retireAfterRestore("Finished",false,village) and not shop.busy)
  assert(shop.lastTransaction.status=="uncertain" and shop.lastTransaction.retiredAfterRestore)
  assert(core.state.wallet.pt==140 and writes==1 and count==3)
''')
print("PASS Lua 5.4: uncertain native delivery stays locked until restored village, no refund or replay")
