-- Free Arena: a FreeSide quest in the game's own quest counter.
-- No REFramework UI, synthetic confirmation, or player-input hooks.
local ID, BASE = 900101, 101
local QUEST_TYPE_TOUR = 32
local marker = "MHRResearch_FreeArena_v1"
local retained, installed, stopped, ticks = {}, false, false, 0
local status = "Waiting for the quest catalogue"
local labels = {
    [0] = "自由竞技场 / Free Arena",
    [1] = "竞技场管理员",
    [2] = "携带自己的装备，自由探索空场。\n无时间限制、无狩猎目标。\n通过任务菜单完成探索并返回。",
    [3] = "自由探索竞技场",
    [4] = "探索任务不会失败"
}
local function retain(obj)
    assert(obj, "Cannot retain a nil object")
    obj:add_ref()
    retained[#retained + 1] = obj
    return obj
end
local function clone_fields(original)
    local td = original:get_type_definition()
    local copy = retain(assert(sdk.create_instance(td:get_full_name(), true), "Cannot allocate " .. td:get_full_name()))
    for _, field in ipairs(td:get_fields()) do
        if not field:is_static() then
            copy:set_field(field:get_name(), original:get_field(field:get_name()))
        end
    end
    return copy
end
local function install()
    local qm = sdk.get_managed_singleton("snow.QuestManager")
    if not qm then return false end
    local dict = qm:get_field("_QuestDataDictionary")
    if not dict or not dict:call("ContainsKey", BASE) then return false end
    if dict:call("ContainsKey", ID) then
        local existing = dict:call("get_Item", ID):call("get_RawNormal")
        local name = existing:get_field("_DbgName")
        assert((name == marker or name == "MhwRogue_FreeArena_v1")
            and existing:get_field("_QuestType") == QUEST_TYPE_TOUR
            and existing:get_field("_MapNo") == 10
            and existing:get_field("_TimeLimit") == 0, "Quest ID collision: 900101")
        log.info("FreeArena: adopted existing quest 900101 (" .. tostring(name) .. ")")
        return true
    end
    local source = qm:call("getQuestData(System.Int32)", BASE)
    local normal = clone_fields(source:call("get_RawNormal"))
    local enemy = clone_fields(source:call("get_RawEnemy"))
    assert(normal:get_field("_QuestType") == QUEST_TYPE_TOUR, "Base is not a FreeSide expedition")
    assert(normal:get_field("_TimeLimit") == 0, "Base is not untimed")
    normal:set_field("_QuestNo", ID)
    normal:set_field("_MapNo", 10)
    normal:set_field("_DbgName", marker)
    enemy:set_field("_QuestNo", ID)
    enemy:set_field("_EmsSetNo", 0)
    local quest = retain(assert(sdk.create_instance("snow.quest.QuestData", true), "Cannot allocate QuestData"))
    quest:call("set_RawNormal", normal)
    quest:call("set_RawEnemy", enemy)
    local quest_type = sdk.find_type_definition("snow.quest.QuestData")
    local text_method = assert(quest_type:get_method("getQuestTextCore"), "Missing quest text API")
    local list_method = assert(qm:get_type_definition():get_method("makeQuestNoList"), "Missing quest list API")
    sdk.hook(text_method, function(args)
        local storage = thread.get_hook_storage()
        storage.free_arena_text = nil
        -- Compare identity without making a nested engine call from the hook.
        if args[2] == sdk.to_ptr(quest) then
            local replacement = labels[sdk.to_int64(args[3])]
            if replacement then
                storage.free_arena_text = replacement
                return sdk.PreHookResult.SKIP_ORIGINAL
            end
        end
    end, function(retval)
        local replacement = thread.get_hook_storage().free_arena_text
        -- Return a fresh frame-local string, as the original engine API does.
        -- A cached managed string crosses repeated caller ownership transfers.
        if replacement then
            return sdk.to_ptr(sdk.create_managed_string(replacement))
        end
        return retval
    end)
    sdk.hook(list_method, function() end, function(retval)
        local list = sdk.to_managed_object(retval)
        -- Original tour 101 is in the village FreeSide list. Add only there.
        if installed and list and list:call("Contains", BASE) and not list:call("Contains", ID) then
            list:call("Add", ID)
            log.info("FreeArena: added 900101 to the FreeSide quest list")
        end
        return retval
    end)
    dict:call("set_Item", ID, quest)
    status = "Installed 900101 / FreeSide TOUR / Map 10 / no time limit"
    log.info("FreeArena: " .. status)
    json.dump_file("free_arena_install.json", {
        installed=true, backend="REFramework Lua", id=ID, base=BASE,
        menu="FreeSide", quest_type=QUEST_TYPE_TOUR, map=10, time_limit=0
    })
    return true
end
re.on_frame(function()
    if installed or stopped then return end
    ticks = ticks + 1
    if ticks % 120 ~= 0 then return end
    local ok, result = pcall(install)
    if ok then installed = result else
        stopped = true
        status = "Install failed: " .. tostring(result)
        log.error("FreeArena: " .. status)
        json.dump_file("free_arena_install.json", {installed=false,error=status})
    end
end)

