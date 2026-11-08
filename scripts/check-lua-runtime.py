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
    local s=new(m.RunSession,core,m.catalog,p)
    local net={steam_digest=wire_hash,steam_plan=function(_,text) assert(#text<=2048);bus.plan=text;return true end,
      steam_ack=function(_,text) bus.acks[self]=text;return true end,
      steam_snapshot=function() return {lobbies={{id="l",owner="h",self=self,plan=bus.plan,
        members={{id="h",ack=bus.acks.h or ""},{id="g",ack=bus.acks.g or ""}}}}} end}
    local runtime={publish=function(_,plan) p.published=plan end,report=function() end}
    local run=new(m.MultiplayerRun,{lobby="l",owner="h",self=self,session="s",members={"h","g"}},cfg,m.catalog,s,runtime,function() return false end,net)
    p.run=run
    local w={index=0,mode="single",typeTag="A",label="entry",monsters={"Great Izuchi"},tier="weak",hpMul=1,dmgMul=1,rewardMul=0,rewardPt=0}
    assert(s:adoptMultiplayerEntry(m.makeQuestPlan(nil,cfg,m.catalog,w,1,1,false)).ok)
    s:tick()
    return {s=s,run=run,core=core,p=p}
  end
  local h,g=peer("h"),peer("g")
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
''')
print("PASS Lua 5.4: two-peer multiplayer choice/staging/commit/activation/reward and personal-wallet isolation")
