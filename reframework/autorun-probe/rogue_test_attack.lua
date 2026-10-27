-- Temporary runtime attack bonus; no weapon/save data edits.
-- API precedent: Bimmr/Monster-Hunter-Rise-Reframework-Scripts-, Buffer Character.lua.
local enabled, cached, status = false, nil, "OFF"
local target=1000000
local function restore()
    if cached then
        cached.data:set_field("_AtkUpAlive",cached.original)
        cached.data:release()
        cached=nil
    end
end
local function tick()
    local qm=sdk.get_managed_singleton("snow.QuestManager")
    local stage=sdk.get_managed_singleton("snow.stage.StageManager")
    local allowed=qm and stage and not stage:call("get_IsQuestOnline") and qm:call("isPlayQuest")
    local id=allowed and qm:call("get_ActiveQuestNo")
    if not enabled or not allowed or (id~=900101 and id~=900102) then
        restore()
        if enabled then enabled=false;status="OFF: left solo custom arena" end
        return
    end
    local pm=sdk.get_managed_singleton("snow.player.PlayerManager")
    local player=pm and pm:call("findMasterPlayer")
    local data=player and player:call("get_PlayerData")
    if not data then restore();status="Waiting for local player";return end
    local unique=qm:call("getActiveQuestUniqueNo")
    if cached and (cached.address~=tostring(data:get_address()) or cached.unique~=unique) then restore() end
    if not cached then
        local attack=data:get_field("_Attack")
        local original=data:get_field("_AtkUpAlive")
        assert(type(attack)=="number" and type(original)=="number","Player attack fields unavailable")
        data:add_ref()
        cached={data=data,address=tostring(data:get_address()),unique=unique,original=original,bonus=original+target-attack}
    end
    data:set_field("_AtkUpAlive",cached.bonus)
    status="ON: current attack "..tostring(data:get_field("_Attack")).." (target 1000000)"
end
re.on_frame(function()
    local ok,err=pcall(tick)
    if not ok then
        enabled=false
        local restored,restoreError=pcall(restore)
        status=tostring(err)..(not restored and ("; restore failed: "..tostring(restoreError)) or "")
    end
end)
re.on_draw_ui(function()
    if imgui.tree_node("TEST: Million Attack") then
        if imgui.button(enabled and "Million attack: ON (click to restore)" or "Million attack: OFF (click to enable)") then
            enabled=not enabled
        end
        imgui.text(status)
        imgui.text("Solo 900101/900102 only. Toggle OFF before changing equipment.")
        imgui.tree_pop()
    end
end)
re.on_script_reset(function()
    enabled=false
    local ok,err=pcall(restore)
    if not ok then log.error("[MillionAttack] restore failed: "..tostring(err)) end
end)
