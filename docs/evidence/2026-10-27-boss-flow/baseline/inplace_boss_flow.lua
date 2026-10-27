-- Observe the native boss scheduler. No field writes or gameplay method calls.
local events, hooks, last, dirty, next_save, frame = {}, {}, nil, false, 0, 0
local path="rogue_inplace_boss_flow.json"
local function scoped()
    local qm=sdk.get_managed_singleton("snow.QuestManager")
    local stage=sdk.get_managed_singleton("snow.stage.StageManager")
    return qm and stage and not stage:call("get_IsQuestOnline") and
        qm:call("isActiveQuest") and qm:call("get_ActiveQuestNo")==900102
end
local function array(a)
    local out={}
    if a then for i=0,math.min(a:get_size(),12)-1 do out[#out+1]=a:call("Get",i) end end
    return out
end
local function info(e)
    if not e then return nil end
    local param=e:call("get_EnemySetParam")
    return {id=e:call("get_EmSetId"),gen=e:call("get_EmGenId"),uid=e:call("get_UniqueId"),
        status=e:call("get_SetStatus"),destroy=e:call("get_DestroyStatus"),
        owner=e:call("get_OwnerEnemy")~=nil,type=param and param:get_field("_TypeValue")}
end
local function state()
    local qm=sdk.get_managed_singleton("snow.QuestManager")
    local out={unique=qm:call("getActiveQuestUniqueNo"),phase=qm:get_field("_ExtraEmRno"),
        count=qm:get_field("_BossSetCount"),extra=qm:get_field("_ExtraSetCount"),
        order=array(qm:get_field("_BossSetNoTbl")),loadOk=array(qm:get_field("_BossLoadStartOk")),
        loadDone=array(qm:get_field("_BossLoadDone")),slots={}}
    local slots=qm:get_field("_BossSet")
    for i=0,math.min(slots:get_size(),7)-1 do
        local s=slots:get_element(i)
        out.slots[#out.slots+1]={id=s:get_field("EmSetId"),type=s:get_field("EmType"),state=s:get_field("State")}
    end
    return out
end
local function add(event, detail)
    if #events>=1200 then table.remove(events,1) end
    events[#events+1]={event=event,at=os.time(),clock=os.clock(),frame=frame,detail=detail}
    dirty=true
end
local function observe(where)
    if not scoped() then return end
    local s=state()
    local key=json.dump_string(s)
    if key~=last then last=key; add(where,s) end
end
for _,spec in ipairs({
    {"snow.QuestManager","updateBossEnemy"},
    {"snow.QuestManager","updateExtraEnemyCommon"},
    {"snow.QuestManager","setBossLoadStartOk"},
    {"snow.QuestManager","netSendBossLoad"},
    {"snow.enemy.EnemyManager","requestLoadEnemy"},
    {"snow.enemy.EnemyManager","createEnemyFromSetInfo"},
}) do
    local key=spec[1].."."..spec[2]
    local ok,err=pcall(function()
        local method=sdk.find_type_definition(spec[1]):get_method(spec[2])
        assert(method,"Method missing")
        sdk.hook(method,function(args)
            local success,error=pcall(function()
                if not scoped() then return end
                if spec[2]=="updateBossEnemy" or spec[2]=="updateExtraEnemyCommon" then
                    observe("pre:"..spec[2])
                elseif spec[2]=="createEnemyFromSetInfo" then
                    add("create:request",{info=info(sdk.to_managed_object(args[3])),setType=sdk.to_int64(args[4]),scheduler=state()})
                else
                    add("call:"..spec[2],{arg1=sdk.to_int64(args[3]),scheduler=state()})
                end
            end)
            if not success then add("hook-error",{hook=key,error=tostring(error)}) end
        end,function(retval)
            local success,error=pcall(function()
                if not scoped() then return end
                if spec[2]=="createEnemyFromSetInfo" then
                    local e=sdk.to_managed_object(retval)
                    add("create:return",{present=e~=nil,uid=e and e:call("get_UniqueId"),type=e and e:call("get_EnemyType")})
                else observe("post:"..spec[2]) end
            end)
            if not success then add("hook-error",{hook=key,error=tostring(error)}) end
            return retval
        end)
    end)
    hooks[key]=ok and "installed" or tostring(err)
end
local function save()
    json.dump_file(path,{readOnly=true,hooks=hooks,at=os.time(),events=events},2)
    dirty=false
end
re.on_frame(function()
    frame=frame+1
    local ok,err=pcall(observe,"frame")
    if not ok then add("frame-error",tostring(err)) end
    if dirty and os.time()>=next_save then next_save=os.time()+1;pcall(save) end
end)
re.on_draw_ui(function()
    if imgui.tree_node("inPlace boss scheduler (READ ONLY)") then
        imgui.text("Events: "..#events..". No mutations. Solo 900102 only.")
        if imgui.button("Save boss scheduler trace") then pcall(save) end
        imgui.tree_pop()
    end
end)
log.info("[inPlace] read-only boss scheduler hooks installed")
