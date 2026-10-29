-- Read-only survey. No hooks, warp setters, gameplay writes or manual flow updates.
-- Idle: one automatic baseline when the local player becomes available, then no polling.
-- Record: 10 Hz in memory for 60 seconds (max 610 samples), flushed only at end.
local OUTPUT = "rogue_warp_survey.json"
local META = "rogue_warp_survey_metadata.json"
local samples, pending, recording, deadline, next_sample = {}, nil, false, 0, 0
local baseline, exported, last_error = false, false, nil
local writes, status = 0, "Waiting for local player; no warp actions are available here."
local next_baseline = 0
local function clock() return os.clock() end
local function attempt(fn)
    local ok, value = pcall(fn)
    if ok then return value end
    return {error=tostring(value)}
end
local function call(obj, name)
    if not obj then return {unavailable=true} end
    return attempt(function() return obj:call(name) end)
end
local function field(obj, name)
    if not obj then return {unavailable=true} end
    return attempt(function() return obj:get_field(name) end)
end
local function vec(value)
    if not value or type(value)=="table" and value.error then return value end
    return attempt(function()
        return {x=value.x, y=value.y, z=value.z}
    end)
end
local function scalar(value)
    if value==nil then return {isNil=true} end
    if type(value)=="number" or type(value)=="boolean" or type(value)=="string" or type(value)=="table" then return value end
    return tostring(value)
end
local function singleton(name) return sdk.get_managed_singleton(name) end
local function camp_list(stage)
    local list=stage and stage:call("get_ExistCampList")
    if not list then return {unavailable=true} end
    local count=list:call("get_Count")
    assert(type(count)=="number" and count>=0 and count<=16,"Unexpected camp count")
    local result={count=count,values={}}
    for i=0,count-1 do result.values[#result.values+1]=scalar(list:call("get_Item",i)) end
    return result
end
local function snapshot(reason)
    local stage=singleton("snow.stage.StageManager")
    local qm=singleton("snow.QuestManager")
    local pm=singleton("snow.player.PlayerManager")
    local player=pm and pm:call("findMasterPlayer")
    return {
        at=os.time(),clock=clock(),reason=reason,hasStage=stage~=nil,hasPlayer=player~=nil,
        quest={active=scalar(call(qm,"isActiveQuest")),playing=scalar(call(qm,"isPlayQuest")),
            questId=scalar(call(qm,"get_ActiveQuestNo")),unique=scalar(call(qm,"getActiveQuestUniqueNo")),
            online=scalar(call(stage,"get_IsQuestOnline"))},
        stage={flow=scalar(call(stage,"get_CurrentWarpFlow")),moving=scalar(call(stage,"get_IsWarpFlowMoving")),
            warpPos=vec(field(stage,"_WarpPos")),warpRot=scalar(field(stage,"_WarpRot")),
            warpWaitCount=scalar(field(stage,"_WarpWaitCount")),inTent=scalar(call(stage,"get_IsInTent")),
            tentIndex=scalar(call(stage,"get_TentIndex")),camps=attempt(function() return camp_list(stage) end)},
        player={pos=vec(field(player,"_PosAfterMotionUpdate")),areaMove=scalar(call(player,"get_AreaMoveFlag")),
            isAreaMove=scalar(call(player,"isAreaMove")),
            areaNo=scalar(call(pm,"getMasterPlayerAreaNo")),
            requestedPos=vec(call(pm,"get_ChangeRequestPlayerPos")),
            positionController=attempt(function()
                local ctrl=player and player:call("get_RefPosCtrl")
                return ctrl and ctrl:get_type_definition():get_full_name() or "unavailable"
            end)}
    }
end
local function metadata()
    local result={at=os.time(),readOnly=true,types={}}
    for _,name in ipairs({"snow.stage.StageManager","snow.stage.StageManager.WarpFlow",
        "snow.stage.StageDef.CampType","snow.player.PlayerManager","snow.player.PlayerBase",
        "snow.player.PlayerBase.AreaMoveType","snow.player.PositionCtrl"}) do
        result.types[name]=attempt(function()
            local td=sdk.find_type_definition(name)
            if not td then return {missing=true} end
            local out={fields={},methods={}}
            for _,f in ipairs(td:get_fields()) do
                out.fields[#out.fields+1]={name=f:get_name(),type=f:get_type():get_full_name(),
                    offset=f:get_offset_from_base(),static=f:is_static()}
            end
            for _,m in ipairs(td:get_methods()) do
                local n=m:get_name()
                if name:find("PositionCtrl",1,true) or n:find("Warp") or n:find("Camp") or
                    n:find("Tent") or n:find("Area") or n:find("ChangeRequestPlayerPos") then
                    local params={}
                    for _,t in ipairs(m:get_param_types() or {}) do params[#params+1]=t:get_full_name() end
                    out.methods[#out.methods+1]={name=n,params=params,static=m:is_static(),
                        returns=m:get_return_type():get_full_name(),address=tostring(m:get_function())}
                end
            end
            return out
        end)
    end
    json.dump_file(META,result,2)
    exported=true
end
local function flush(reason)
    json.dump_file(OUTPUT,{at=os.time(),readOnly=true,reason=reason,recording=false,
        samplingHz=10,maxSamples=610,writes=writes+1,samples=samples,lastError=last_error},2)
    writes=writes+1
end
local function stop(reason)
    recording=false
    flush(reason)
    status="Saved "..#samples.." samples; idle (no state polling)."
end
re.on_frame(function()
    local now=clock()
    if not pending and not recording and baseline then return end
    if not pending and not recording and now<next_baseline then return end
    local ok,err=pcall(function()
        if not baseline and not pending then
            next_baseline=now+2
            local pm=singleton("snow.player.PlayerManager")
            local player=pm and pm:call("findMasterPlayer")
            -- The object exists before its position is initialized (InitWait / 0,0,0).
            -- Wait for the native area transition to finish before calling this a baseline.
            if not player or player:call("get_AreaMoveFlag")==0 or player:call("isAreaMove") then return end
            if not exported then metadata() end
            samples={snapshot("auto-baseline")};baseline=true;stop("auto-baseline")
        elseif pending then
            local command=pending;pending=nil
            if command=="stop" then stop("manual-stop");return end
            if not exported then metadata() end
            if command=="record" then
                samples={snapshot("record-start")};recording=true;deadline=now+60;next_sample=now+0.1
                baseline=true;status="Recording for 60 seconds in memory. Use normal game travel."
            else
                samples={snapshot("manual-snapshot")};baseline=true;stop("manual-snapshot")
            end
        elseif recording then
            if now>=deadline or #samples>=610 then stop("record-complete")
            elseif now>=next_sample then
                next_sample=now+0.1;samples[#samples+1]=snapshot("sample")
            end
        end
    end)
    if not ok then
        recording=false;pending=nil;baseline=true;last_error=tostring(err)
        status="Stopped: "..last_error
        pcall(flush,"error") -- Single error write, no per-frame retry.
    end
end)
re.on_draw_ui(function()
    if imgui.tree_node("TEST: Warp survey (READ ONLY)") then
        imgui.text(status)
        imgui.text("No teleport / cat cart / tent / flow setter is called.")
        if not recording then
            if imgui.button("Snapshot once") then pending="snapshot" end
            if imgui.button("Record normal travel for 60 seconds") then pending="record" end
        elseif imgui.button("Stop and save recording") then pending="stop" end
        imgui.tree_pop()
    end
end)
re.on_script_reset(function()
    if recording then pcall(stop,"script-reset") end
end)
