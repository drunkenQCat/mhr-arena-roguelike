-- Manual single-shot experiment: register a fresh boss record, then use native loading.
-- Does NOT call createEnemyFromSetInfo or change quest kill/clear counters.
local pending, message=false,"Requires cleared first boss; second boss still alive."
local path="rogue_inplace_register_experiment.json"
local ledger={events={}}
pcall(function() local old=json.load_file(path);if old and old.events then ledger=old end end)
local function log(event,detail)
    ledger.events[#ledger.events+1]={event=event,at=os.time(),detail=detail}
    json.dump_file(path,ledger,2)
end
local function run()
    local qm=sdk.get_managed_singleton("snow.QuestManager")
    local stage=sdk.get_managed_singleton("snow.stage.StageManager")
    assert(qm and stage and not stage:call("get_IsQuestOnline"),"Solo only")
    assert(qm:call("isPlayQuest") and qm:call("get_ActiveQuestNo")==900102,"Playing M2a only")
    local unique=qm:call("getActiveQuestUniqueNo")
    for _,e in ipairs(ledger.events) do assert(not(e.event=="before" and e.detail.unique==unique),"One attempt per quest") end
    assert(qm:get_field("_ExtraEmRno")==10 and qm:get_field("_BossSetCount")==2,"Scheduler must have exhausted exactly two bosses")
    local order=qm:get_field("_BossSetNoTbl")
    assert(order:call("Get",2)==-1 and order:call("Get",3)==-1,"Third/fourth order entries must be empty")
    local slots=qm:get_field("_BossSet")
    local slot=slots:get_element(2)
    assert(slot:get_field("EmSetId")==-1 and slot:get_field("State")==0,"Third task slot must be unused")
    local em=sdk.get_managed_singleton("snow.enemy.EnemyManager")
    local old=em:call("getEnemySetInfo(System.Int32)",0)
    assert(old and old:call("get_SetStatus")==4 and old:call("get_DestroyStatus")==2 and not old:call("get_OwnerEnemy"),"First corpse must be fully cleared")
    local param=old:call("get_EnemySetParam")
    assert(param:get_field("_TypeValue")==98,"Original type must be Great Izuchi")
    assert(em:call("getBossEnemyCount")==1,"Exactly one second boss must remain")
    local second=em:call("getBossEnemy",0)
    assert(second:call("get_EnemyType")==54 and not second:call("isDieBehaviorActive"),"Second boss must be alive")
    local before=em:get_field("_EnemySetInfoList"):call("get_Count")
    -- Persist before the first native mutation. No automatic retry after any failure.
    log("before",{unique=unique,count=before,phase=10,orderIndex=2,taskSlot=2,type=98})
    local fresh=em:call("createEnemySetInfo(snow.quest.EnemySetParam)",param)
    assert(fresh,"Native registration returned nil")
    local id=fresh:call("get_EmSetId")
    local uid=fresh:call("get_UniqueId")
    assert(id>=before and uid~=0 and uid~=100 and fresh:call("get_SetStatus")==0 and not fresh:call("get_OwnerEnemy"),"New record identity/status invalid")
    log("registered",{unique=unique,id=id,uid=uid,count=em:get_field("_EnemySetInfoList"):call("get_Count")})
    slot:set_field("EmSetId",id)
    slot:set_field("EmType",98)
    slot:set_field("State",0)
    qm:get_field("_BossLoadStartOk"):call("Set",2,false)
    qm:get_field("_BossLoadDone"):call("Set",2,0)
    order:call("Set",2,2)
    -- The observed native RequestLoad stage performs deletion checks, resource loading,
    -- load waiting and sync before it reaches CreateEnemy. Never jump to CreateEnemy.
    qm:set_field("_ExtraEmRno",5)
    log("requested-native-load",{unique=unique,id=id,uid=uid,phase=5})
    message="Fresh record registered. Native loading requested; observe spawn and UID."
end
re.on_frame(function()
    if pending then
        pending=false
        local ok,err=pcall(run)
        if not ok then message=tostring(err);log("error",message) end
    end
end)
re.on_draw_ui(function()
    if imgui.tree_node("inPlace fresh native boss registration") then
        imgui.text(message)
        if imgui.button("REGISTER third Great Izuchi via native loader ONCE") then pending=true end
        imgui.tree_pop()
    end
end)
