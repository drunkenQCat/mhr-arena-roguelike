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
  log = {info = function() end, warn = function() end, error = function() end}
  json = {load_file = function() return nil end,
    dump_file = function(path, data) reports[path] = data; return true end}
  thread = {get_hook_storage = function() return {} end}
  sdk = {PreHookResult = {CALL_ORIGINAL = 0, SKIP_ORIGINAL = 1}}
  re = {on_frame = function(cb) callbacks.frame = cb end,
    on_draw_ui = function(cb) callbacks.ui = cb end,
    on_script_reset = function(cb) callbacks.reset = cb end}
  imgui = {tree_node = function() return false end}
''')
host.execute(original_bundle)
assert host.globals().reports["mhw_rogue_boot.json"].ok is True
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
