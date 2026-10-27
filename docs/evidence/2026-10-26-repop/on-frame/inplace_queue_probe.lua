-- T3 trace plus an explicitly requested, one-shot native repop experiment.
-- Installed only for the experiment; active only in solo quest 900102.
local rows, metadata, hits, last, next_at = {}, {}, {}, nil, 0
local path = "rogue_inplace_queue_trace.json"
local pending_repop, repop_unique, experiment = false, nil, {}
local status = "Trace active. Repop is manual, first cleared boss slot only."
local function attempt(fn)
    local ok, value = pcall(fn)
    if ok then return value end
    return { error = tostring(value) }
end
local function scoped()
    local qm = sdk.get_managed_singleton("snow.QuestManager")
    local stage = sdk.get_managed_singleton("snow.stage.StageManager")
    return qm and stage and not stage:call("get_IsQuestOnline") and
        qm:call("isActiveQuest") and qm:call("get_ActiveQuestNo") == 900102
end
local function describe(td)
    local name = td:get_full_name()
    if metadata[name] then return end
    local parent = td:get_parent_type()
    local out = { fields = {}, methods = {}, parent = parent and parent:get_full_name() }
    metadata[name] = out
    for _, f in ipairs(td:get_fields()) do
        if not f:is_static() then out.fields[#out.fields+1] = { name=f:get_name(), type=f:get_type():get_full_name() } end
    end
    for _, m in ipairs(td:get_methods()) do
        local params = {}
        for _, t in ipairs(m:get_param_types() or {}) do params[#params+1]=t:get_full_name() end
        out.methods[#out.methods+1]={name=m:get_name(),params=params}
    end
    if parent then describe(parent) end
end
local function value(v, depth)
    if v == nil then return "<nil>" end
    if type(v) == "number" or type(v) == "boolean" or type(v) == "string" then return v end
    if depth == 0 then return tostring(v) end
    return attempt(function()
        -- Vectors may be native value userdata with no reflection methods.
        if not v.get_type_definition then return { nativeValue = tostring(v) } end
        local td = v:get_type_definition()
        describe(td)
        local out = { type=td:get_full_name() }
        if out.type:sub(-2) == "[]" then
            out.total=v:get_size()
            out.items={}
            for i=0,math.min(v:get_size(),12)-1 do out.items[#out.items+1]=value(v:get_element(i),depth-1) end
        elseif out.type:find("System.Collections.Generic.List",1,true) then
            out.total=v:call("get_Count")
            out.items={}
            for i=0,math.min(v:call("get_Count"),12)-1 do out.items[#out.items+1]=value(v:call("get_Item",i),depth-1) end
        else
            out.fields={}
            local level = td
            for _=1,6 do
              if not level then break end
              for _, f in ipairs(level:get_fields()) do
                if not f:is_static() then
                    local name=f:get_name()
                    -- Owner behaviors and packet caches are not traversed.
                    if not name:find("OwnerEnemy") and not name:find("CachePacket") then
                        out.fields[name]=attempt(function() return value(v:get_field(name),depth-1) end)
                    end
                end
              end
              level=level:get_parent_type()
            end
        end
        return out
    end)
end
local qm_fields={"_QuestStatus","_QuestPhase","_IsBossRush","_BossSet","_BossSetCond","_BossSetNoTbl",
    "_BossSetCount","_ExtraSetCount","_SwapSetNoTbl","_BossLoadStartOk","_BossLoadDone",
    "_QuestTargetEmDieUidListCount","_QuestTargetEmDieUidList","_QuestTargetData"}
local function snapshot()
    local qm=sdk.get_managed_singleton("snow.QuestManager")
    local em=sdk.get_managed_singleton("snow.enemy.EnemyManager")
    local out={unique=qm:call("getActiveQuestUniqueNo"),playing=qm:call("isPlayQuest"),quest={},enemies={}}
    for _, n in ipairs(qm_fields) do out.quest[n]=attempt(function() return value(qm:get_field(n),4) end) end
    if em then
        out.enemies.sets=value(em:get_field("_EnemySetInfoList"),4)
        out.enemies.load=value(em:get_field("_RequestLoadEnemyList"),3)
        out.enemies.bosses={}
        for i=0,math.min(em:call("getBossEnemyCount"),8)-1 do
            local e=em:call("getBossEnemy",i)
            out.enemies.bosses[#out.enemies.bosses+1]={uid=e:call("get_UniqueId"),type=e:call("get_EnemyType"),dying=e:call("isDieBehaviorActive")}
        end
    end
    return out
end
local function write()
    json.dump_file(path,{readOnly=#experiment==0,at=os.time(),samples=rows,types=metadata,hooks=hits,experiment=experiment},2)
end
local function record(event, detail)
    experiment[#experiment+1]={at=os.time(),event=event,detail=detail}
    json.dump_file("rogue_inplace_repop_experiment.json",{events=experiment},2)
end
local function repop_first_cleared()
    if not scoped() then error("Requires solo custom quest 900102") end
    local qm=sdk.get_managed_singleton("snow.QuestManager")
    if not qm:call("isPlayQuest") then error("Quest is not playing") end
    local unique=qm:call("getActiveQuestUniqueNo")
    if repop_unique==unique then error("Already attempted repop once in this quest") end
    local em=sdk.get_managed_singleton("snow.enemy.EnemyManager")
    local list=em:get_field("_EnemySetInfoList")
    local target
    for i=0,list:call("get_Count")-1 do
        local entry=list:call("get_Item",i)
        if entry:call("get_EmSetId")==0 then target=entry; break end
    end
    if not target then error("Original first boss slot missing") end
    if target:call("get_SetStatus")~=4 or target:call("get_DestroyStatus")~=2 then error("First boss must be dead AND cleaned up (End / DestroyDead)") end
    local uid=target:call("get_UniqueId")
    for i=0,em:call("getBossEnemyCount")-1 do
        if em:call("getBossEnemy",i):call("get_UniqueId")==uid then error("Original boss object still exists") end
    end
    local param=target:call("get_EnemySetParam")
    local kind=param:get_field("_TypeValue")
    if kind~=98 then error("Expected original Great Izuchi (98), got "..tostring(kind)) end
    local dead=qm:get_field("_QuestTargetEmDieUidList")
    local found=false
    for i=0,dead:get_size()-1 do if dead:call("Get",i)==uid then found=true end end
    if not found then error("Native quest has not recorded the original death") end
    if not target:get_type_definition():get_method("repop()") then error("Exact repop() method missing") end
    repop_unique=unique -- No retries after entering the native call, even if it throws.
    record("before-repop",{unique=unique,uid=uid,slot=value(target,4),quest=value(qm:get_field("_BossSet"),3),type=kind})
    target:call("repop()") -- The only game mutation in this experiment.
    record("after-repop",{unique=unique,slot=value(target,4)})
    status="repop() called once. Watching slot 0; no IDs or counters changed."
end
for _, target in ipairs({
    {"snow.QuestManager","setupQuestEnemySub"},
    {"snow.QuestManager","checkNextEnemyAppearCondition"},
    {"snow.QuestManager","getBossSetInfo"},
    {"snow.enemy.EnemyManager","createEnemySetInfo"},
    {"snow.enemy.EnemyManager","createEnemyFromSetInfo"},
    {"snow.enemy.EnemySetInfo","repop"},
}) do
    attempt(function()
        local td=sdk.find_type_definition(target[1])
        if not td then return end
        describe(td)
        local m=td:get_method(target[2])
        if not m then return end
        local key=target[1].."."..target[2]
        hits[key]={count=0}
        sdk.hook(m,function()
            if scoped() then
                hits[key].count=hits[key].count+1
                hits[key].lastAt=os.time()
            end
        end)
    end)
end
re.on_frame(function()
    if pending_repop then
        pending_repop=false
        local ok,err=pcall(repop_first_cleared)
        if not ok then status=tostring(err); record("repop-error",status) end
    end
    if os.time()<next_at then return end
    next_at=os.time()+1
    if not scoped() then return end
    local out=attempt(snapshot)
    local key=json.dump_string(out)
    if key ~= last and #rows<180 then
        rows[#rows+1]={at=os.time(),state=out}
        last=key
    end
    attempt(write)
end)
re.on_draw_ui(function()
    if not imgui.tree_node("inPlace T3 queue / repop experiment") then return end
    imgui.text("Solo 900102. Samples: "..#rows..". Repop requires first boss corpse removed.")
    imgui.text(status)
    if imgui.button("EXPERIMENT: repop cleared FIRST boss ONCE") then pending_repop=true end
    if imgui.button("Save queue trace now") then attempt(write) end
    imgui.tree_pop()
end)
log.info("[inPlace probe] read-only queue trace loaded")
