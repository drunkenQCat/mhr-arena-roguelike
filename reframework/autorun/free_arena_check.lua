-- Verify the installed quest without changing the player/save.
local checked, frames = false, 0
re.on_frame(function()
    if checked then return end
    frames = frames + 1
    if frames % 120 ~= 0 then return end
    local qm = sdk.get_managed_singleton("snow.QuestManager")
    if not qm then return end
    local dict = qm:get_field("_QuestDataDictionary")
    if not dict or not dict:call("ContainsKey", 900101) then return end
    local ok, err = pcall(function()
        local quest = qm:call("getQuestData(System.Int32)", 900101)
        local normal = quest:call("get_RawNormal")
        local enemy = quest:call("get_RawEnemy")
        assert(normal:get_field("_QuestType") == 32)
        assert(normal:get_field("_MapNo") == 10)
        assert(normal:get_field("_TimeLimit") == 0)
        assert(normal:get_field("_QuestLv") == 0)
        assert(normal:get_field("_EnemyLv") == 0)
        assert(enemy:get_field("_EmsSetNo") == 0)
        local monsters = normal:get_field("_BossEmType")
        for i = 0, monsters:get_size() - 1 do assert(monsters:call("Get", i) == 0) end
        json.dump_file("free_arena_status.json", {
            installed=true, id=900101, map=10, time_limit=0,
            rank="village FreeSide tour", quest_type=32, monsters=0,
            departure_verified=false, return_verified=false
        })
        log.info("FreeArenaCheck: PASS quest 900101 registered; map=10 type=32 time=0 monsters=0")
    end)
    checked = true
    if not ok then log.error("FreeArenaCheck: " .. tostring(err)) end
end)
