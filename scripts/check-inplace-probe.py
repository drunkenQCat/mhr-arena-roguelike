"""Exercise queue tracing and one-shot repop guards under Lua 5.4, without a game."""
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
assert(last.latest.at==200 and last.samples[180].at==200, "trace froze after retention cap")
''')
print("PASS inPlace trace: solo scope, false values, read errors, bounded retention")
lua.execute('''
local td={}
function td:get_full_name() return "FakeSlot" end
function td:get_fields() return {} end
function td:get_methods() return {} end
function td:get_parent_type() return nil end
function td:get_method(name) if name=="repop()" or name=="updateSetStatus(snow.enemy.EnemyManager.EnemySetStatus)" or name=="updateDestroyStatus(snow.enemy.EnemyManager.DestroyStatus)" then return {} end end
repop_calls=0; rearm_calls=0; revive_calls=0; destroy_calls=0; unique=42; slot_state=2; slot_destroy=0; quest_no=900102; playing=true; owner=true
local slot={}
function slot:get_type_definition() return td end
function slot:call(name,arg)
    if name=="get_EmSetId" then return 0 end
    if name=="get_SetStatus" then return slot_state end
    if name=="get_DestroyStatus" then return slot_destroy end
    if name=="get_UniqueId" then return 0 end
    if name=="get_EnemySetParam" then return {get_field=function() return 98 end} end
    if name=="get_OwnerEnemy" then return owner and {} or nil end
    if name=="repop()" then repop_calls=repop_calls+1; return end
    if name=="updateSetStatus(snow.enemy.EnemyManager.EnemySetStatus)" then
        assert(arg==0 or arg==1)
        if arg==0 then rearm_calls=rearm_calls+1 else revive_calls=revive_calls+1 end
        slot_state=arg; return
    end
    if name=="updateDestroyStatus(snow.enemy.EnemyManager.DestroyStatus)" then assert(arg==0); destroy_calls=destroy_calls+1; slot_destroy=0; return end
    error("Unexpected slot method "..name)
end
local qm={}
function qm:call(name)
    if name=="isActiveQuest" then return true end
    if name=="isPlayQuest" then return playing end
    if name=="get_ActiveQuestNo" then return quest_no end
    if name=="getActiveQuestUniqueNo" then return unique end
    error("Unexpected quest method "..name)
end
function qm:get_field(name)
    if name=="_QuestTargetEmDieUidList" then return {get_size=function() return 1 end,call=function() return 0 end} end
    return 0
end
local em={}
function em:get_field() return {call=function(_,name) if name=="get_Count" then return 1 else return slot end end} end
function em:call(name)
    if name=="getBossEnemyCount" then return 1 end
    if name=="getBossEnemy" then return {call=function() return 100 end} end
    error("Unexpected enemy method "..name)
end
sdk.get_managed_singleton=function(name)
    if name=="snow.QuestManager" then return qm end
    if name=="snow.stage.StageManager" then return {call=function() return online end} end
    if name=="snow.enemy.EnemyManager" then return em end
end
imgui={tree_node=function() return true end,text=function() end,tree_pop=function() end,
    button=function(label) return label:find("EXPERIMENT:")~=nil end}
local function click() draw(); frame() end
-- No action is automatic. Every invalid request remains non-mutating.
frame(); assert(repop_calls==0)
click(); assert(repop_calls==0, "allowed living boss")
slot_state=4; slot_destroy=2; click(); assert(repop_calls==0, "allowed cleared corpse")
slot_state=3; slot_destroy=0; owner=false; click(); assert(repop_calls==0, "allowed nil OwnerEnemy")
owner=true
online=true; click(); assert(repop_calls==0, "allowed online experiment")
online=false; quest_no=101; click(); assert(repop_calls==0, "allowed another quest")
quest_no=900102; playing=false; click(); assert(repop_calls==0, "allowed settlement")
playing=true; click(); assert(repop_calls==1)
click(); assert(repop_calls==1, "repeated native repop in the same quest")
unique=43
imgui.button=function(label) return label:find("REARM:")~=nil end
slot_state=4; slot_destroy=2; owner=true
click(); assert(rearm_calls==0, "rearm allowed before owner cleared")
owner=false; online=true; click(); assert(rearm_calls==0)
online=false; click(); assert(rearm_calls==1 and slot_state==0)
click(); assert(rearm_calls==1, "repeated rearm in same quest")
imgui.button=function(label) return label:find("DESTROY:")~=nil end
online=true; click(); assert(destroy_calls==0)
online=false; click(); assert(destroy_calls==1 and slot_state==0 and slot_destroy==0)
click(); assert(destroy_calls==1, "repeated destroy reset")
imgui.button=function(label) return label:find("REVIVE:")~=nil end
owner=true; click(); assert(revive_calls==0, "revive allowed occupied slot")
owner=false; online=true; click(); assert(revive_calls==0)
online=false; click(); assert(revive_calls==1 and slot_state==1)
click(); assert(revive_calls==1, "repeated ReviveWait")
unique=44; slot_state=0; slot_destroy=0; click(); assert(revive_calls==1, "ReviveWait without recorded destroy reset")
imgui.button=function(label) return label:find("DESTROY:")~=nil end
unique=44; click(); assert(destroy_calls==1, "destroy reset without prior InitWait")
''')
lua.execute('json.load_file=function() return {events=last.events} end')
# Restore a recorded successful ReviveWait action as if ScriptRunner reset now.
lua.execute('saved_ledger={events={{event="before-revive",detail={unique=43}}}}; json.load_file=function() return saved_ledger end')
lua.execute(source.read_text(encoding="utf-8"))
lua.execute('unique=43; slot_state=0; slot_destroy=0; imgui.button=function(label) return label:find("REVIVE:")~=nil end; draw(); frame(); assert(revive_calls==1,"reset bypassed persisted one-shot guard")')
print("PASS inPlace repop: manual trigger, dead owner present, solo/quest/play scope, one call per quest")
