"""Exercise the read-only queue probe under Lua 5.4; does not run the game."""
from pathlib import Path
from lupa.lua54 import LuaRuntime

lua = LuaRuntime(unpack_returned_tuples=True)
lua.execute('''
now, active, online, broken, writes, last = 0, false, false, false, 0, nil
os.time=function() return now end
local qm={}
function qm:call(name)
    if name=="isActiveQuest" then return active end
    if name=="get_ActiveQuestNo" then return 900102 end
    if name=="getActiveQuestUniqueNo" then return 11 end
    if name=="isPlayQuest" then return false end
    error("Unexpected native call: "..name)
end
function qm:get_field(name)
    if broken then error("unreadable native field") end
    if name=="_IsBossRush" then return false end
    return 0
end
sdk={
    find_type_definition=function() return nil end,
    get_managed_singleton=function(name)
        if name=="snow.QuestManager" then return qm end
        if name=="snow.stage.StageManager" then return {call=function() return online end} end
    end,
}
re={on_frame=function(fn) frame=fn end,on_draw_ui=function(fn) draw=fn end}
log={info=function() end}
json={
    dump_string=function() return tostring(now) end,
    dump_file=function(path,data) writes=writes+1; last=data; return true end,
}
''')
source = Path(__file__).resolve().parent.parent / "reframework/autorun-probe/inplace_queue_probe.lua"
lua.execute(source.read_text(encoding="utf-8"))
lua.execute('''
frame(); assert(writes==0, "probe wrote outside quest")
active=true; now=1; frame()
assert(writes==1 and last.readOnly==true)
assert(last.samples[1].state.playing==false)
assert(last.samples[1].state.quest._IsBossRush==false, "false value was lost")
online=true; now=2; frame(); assert(writes==1, "online scope was not rejected")
online=false; broken=true; now=3; frame()
assert(last.samples[2].state.quest._BossSet.error, "field failures should be recorded")
broken=false
for i=4,200 do now=i; frame() end
assert(#last.samples==180, "unbounded sample retention")
''')
print("PASS inPlace probe: solo scope, false values, read errors, bounded retention; no game mutation APIs")
