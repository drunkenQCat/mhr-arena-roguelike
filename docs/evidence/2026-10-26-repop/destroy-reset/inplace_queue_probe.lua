-- T3 trace plus an explicitly requested, one-shot native repop experiment.
-- Installed only for the experiment; active only in solo quest 900102.
local rows, metadata, hits, last, next_at = {}, {}, {}, nil, 0
local path = "rogue_inplace_queue_trace.json"
local pending_repop, repop_unique, experiment = false, nil, {}
local last_mode
local latest, dropped = nil, 0
local status = "Trace active. Manual dead-corpse repop OR cleared-slot rearm; one mutation per quest."
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
                    elseif name:find("OwnerEnemy") then
                        out.fields[name]=v:get_field(name)~=nil
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
    json.dump_file(path,{readOnly=#experiment==0,at=os.time(),samples=rows,latest=latest,dropped=dropped,types=metadata,hooks=hits,experiment=experiment},2)
end
local function record(event, detail)
    experiment[#experiment+1]={at=os.time(),event=event,detail=detail}
    json.dump_file("rogue_inplace_repop_experiment.json",{events=experiment},2)
end
local function experiment_first_slot(mode)
    if not scoped() then error("Requires solo custom quest 900102") end
    local qm=sdk.get_managed_singleton("snow.QuestManager")
    if not qm:call("isPlayQuest") then error("Quest is not playing") end
    local unique=qm:call("getActiveQuestUniqueNo")
    if mode=="destroy" then
        if repop_unique~=unique or last_mode~="init" then error("Destroy reset requires this quest's completed InitWait experiment") end
    elseif repop_unique==unique then error("Already attempted repop once in this quest") end
    local em=sdk.get_managed_singleton("snow.enemy.EnemyManager")
    local list=em:get_field("_EnemySetInfoList")
    local target
    for i=0,list:call("get_Count")-1 do
        local entry=list:call("get_Item",i)
        if entry:call("get_EmSetId")==0 then target=entry; break end
    end
    if not target then error("Original first boss slot missing") end
    local rearm=mode=="init" or mode=="destroy"
    if mode=="destroy" then
        if target:call("get_SetStatus")~=0 or target:call("get_DestroyStatus")~=2 then error("Destroy reset requires InitWait / DestroyDead") end
        if target:call("get_OwnerEnemy") then error("Destroy reset requires cleared OwnerEnemy") end
    elseif rearm then
        if target:call("get_SetStatus")~=4 or target:call("get_DestroyStatus")~=2 then error("Rearm requires End / DestroyDead") end
        if target:call("get_OwnerEnemy") then error("Rearm requires cleared OwnerEnemy") end
    else
        if target:call("get_SetStatus")~=3 or target:call("get_DestroyStatus")~=0 then error("First boss must be Dead, BEFORE corpse cleanup") end
        if not target:call("get_OwnerEnemy") then error("OwnerEnemy is nil: repop dereferences it; refuse call") end
    end
    local uid=target:call("get_UniqueId")
    for i=0,em:call("getBossEnemyCount")-1 do
        local boss=em:call("getBossEnemy",i)
        if boss:call("get_UniqueId")==uid and (rearm or not boss:call("isDieBehaviorActive")) then error("Original boss not ready for this lifecycle experiment") end
    end
    local param=target:call("get_EnemySetParam")
    local kind=param:get_field("_TypeValue")
    if kind~=98 then error("Expected original Great Izuchi (98), got "..tostring(kind)) end
    local dead=qm:get_field("_QuestTargetEmDieUidList")
    local found=false
    for i=0,dead:get_size()-1 do if dead:call("Get",i)==uid then found=true end end
    if not found then error("Native quest has not recorded the original death") end
    local method=mode=="destroy" and "updateDestroyStatus(snow.enemy.EnemyManager.DestroyStatus)" or
        (rearm and "updateSetStatus(snow.enemy.EnemyManager.EnemySetStatus)" or "repop()")
    if not target:get_type_definition():get_method(method) then error("Exact method missing: "..method) end
    repop_unique=unique -- No retries after entering the native call, even if it throws.
    last_mode=mode -- The next stage is allowed only after a recorded InitWait attempt.
    record("before-"..mode,{unique=unique,uid=uid,slot=value(target,4),quest=value(qm:get_field("_BossSet"),3),type=kind,method=method})
    local ok,err=pcall(function()
        if rearm then target:call(method,0) else target:call(method) end
    end) -- One native mutation per quest.
    record("after-"..mode,{unique=unique,ok=ok,error=not ok and tostring(err) or nil,slot=value(target,4)})
    if not ok then error(err) end
    status=mode.." called once. Watching slot 0; no IDs or counters changed."
end
for _, target in ipairs({
    {"snow.QuestManager","setupQuestEnemySub"},
    {"snow.QuestManager","checkNextEnemyAppearCondition"},
    {"snow.QuestManager","getBossSetInfo"},
    {"snow.enemy.EnemyManager","createEnemySetInfo"},
    {"snow.enemy.EnemyManager","createEnemyFromSetInfo"},
    {"snow.enemy.EnemyManager","updateEnemySetInfo"},
    {"snow.enemy.EnemyManager","updateEnemySetInfoQuestHost"},
    {"snow.enemy.EnemySetInfo","repop"},
}) do
    attempt(function()
        local td=sdk.find_type_definition(target[1])
        if not td then return end
        describe(td)
        local m=td:get_method(target[2])
        if not m then return end
        local key=target[1].."."..target[2]
        hits[key]={count=0,address=tostring(m:get_function())}
        sdk.hook(m,function(args)
            if scoped() then
                hits[key].count=hits[key].count+1
                hits[key].lastAt=os.time()
                if target[2]=="updateEnemySetInfo" or target[2]=="updateEnemySetInfoQuestHost" then
                    hits[key].enableRevival=sdk.to_int64(args[3])~=0
                    hits[key].waveNo=sdk.to_int64(args[4])
                end
            end
        end)
    end)
end
re.on_frame(function()
    if pending_repop then
        local mode=pending_repop
        pending_repop=false
        local ok,err=pcall(experiment_first_slot,mode)
        if not ok then status=tostring(err); record("repop-error",status) end
    end
    if os.time()<next_at then return end
    next_at=os.time()+1
    if not scoped() then return end
    local out=attempt(snapshot)
    local key=json.dump_string(out)
    latest={at=os.time(),state=out}
    if key ~= last then
        if #rows>=180 then table.remove(rows,1); dropped=dropped+1 end
        rows[#rows+1]={at=os.time(),state=out}
        last=key
    end
    attempt(write)
end)
re.on_draw_ui(function()
    if not imgui.tree_node("inPlace T3 queue / repop experiment") then return end
    imgui.text("Solo 900102. Samples: "..#rows..". Repop requires dead corpse still present.")
    imgui.text(status)
    if imgui.button("EXPERIMENT: repop DEAD FIRST boss ONCE") then pending_repop="repop" end
    if imgui.button("REARM: cleared FIRST slot to InitWait ONCE") then pending_repop="init" end
    if imgui.button("DESTROY: after InitWait, clear DestroyDead ONCE") then pending_repop="destroy" end
    if imgui.button("Save queue trace now") then attempt(write) end
    imgui.tree_pop()
end)
log.info("[inPlace probe] queue trace loaded; mutations require manual experiment button")
