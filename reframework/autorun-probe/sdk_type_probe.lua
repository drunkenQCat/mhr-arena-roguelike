-- SDK Stage-2 probe: dump fields/methods of curated snow.* types to JSON.
-- Research tool: lives OUTSIDE autorun (drop into autorun for one game session,
-- harvest <game>/reframework/data/sdk_types.json, then remove).
local SEEDS = {
    "snow.QuestManager",
    "snow.quest.QuestData",
    "snow.enemy.EnemyManager",
    "snow.enemy.EnemyDataManager",
    "snow.enemy.EnemyCharacterBase",
    "snow.player.PlayerManager",
    "snow.player.Player",
    "snow.gui.GuiManager",
    "snow.gui.fsm.itemshop.GuiItemShopFsmManager",
    "snow.gui.GuiItemBoxWindow",
    "snow.stage.StageManager",
    "snow.inventory.InventoryManager",
    "snow.data.ItemPouch",
    "snow.data.ItemBox",
    "snow.data.ItemCount",
    "snow.data.ContentsIdSystem.ItemId",
    "snow.data.ContentsIdSystem",
    "snow.data.DataManager",
    "snow.data.ItemInventoryData",
    "snow.data.ItemSet",
    "snow.data.FacilityDataManager",
    "snow.inventory.InventoryData",
}
local MAX_TYPES = 120
local MAX_METHODS_PER_NAME = 6
local done = false
local ticks = 0

local function type_name(t)
    if not t then return nil end
    local ok, n = pcall(function() return t:get_full_name() end)
    return ok and n or nil
end

local function dump_type(td, out)
    local fields = {}
    local ok_f, fields_raw = pcall(function() return td:get_fields() end)
    if ok_f and fields_raw then
        for _, f in ipairs(fields_raw) do
            local ftype = f:get_type()
            fields[#fields + 1] = {
                name = f:get_name(),
                type = type_name(ftype) or "unknown",
                static = f:is_static(),
                offset = f:get_offset_from_fieldptr(),
            }
        end
    end
    local methods = {}
    local by_name = {}
    local ok_m, methods_raw = pcall(function() return td:get_methods() end)
    if ok_m and methods_raw then
        for _, meth in ipairs(methods_raw) do
            local name = meth:get_name()
            local slot = by_name[name]
            if not slot then
                slot = { name = name, ret = nil, params = {}, static = false, overloads = 0 }
                by_name[name] = slot
                methods[#methods + 1] = slot
            end
            slot.overloads = slot.overloads + 1
            if slot.overloads <= MAX_METHODS_PER_NAME then
                slot.ret = type_name(meth:get_return_type()) or "void"
                slot.static = meth:is_static()
                local ptypes = meth:get_param_types()
                local pnames = meth:get_param_names()
                local ps = {}
                if ptypes then
                    for i, pt in ipairs(ptypes) do
                        ps[#ps + 1] = {
                            name = (pnames and pnames[i]) or ("arg" .. i),
                            type = type_name(pt) or "unknown",
                        }
                    end
                end
                slot.params = ps
            end
        end
    end
    out.full_name = type_name(td)
    out.fields = fields
    out.methods = methods
end

local queue, queued, dumped = {}, {}, {}
for _, n in ipairs(SEEDS) do queue[#queue + 1] = n; queued[n] = true end

re.on_frame(function()
    if done then return end
    ticks = ticks + 1
    if ticks % 120 ~= 0 then return end

    local qm = sdk.get_managed_singleton("snow.QuestManager")
    if not qm then return end -- wait for game load

    local database = {}
    local errors = {}
    local head = 1
    while head <= #queue and #database < MAX_TYPES do
        local name = queue[head]; head = head + 1
        if not dumped[name] then
            dumped[name] = true
            local ok, td = pcall(function() return sdk.find_type_definition(name) end)
            if ok and td then
                local out = {}
                local ok2, err = pcall(dump_type, td, out)
                if ok2 then
                    database[name] = out
                    -- one-hop discovery: queue snow.* field types we have not seen
                    for _, f in ipairs(out.fields or {}) do
                        local ft = f.type
                        if ft and ft:find("^snow%.") and not ft:find("^snow%.enemy%.em%d")
                            and not queued[ft] and #queue + #database < MAX_TYPES * 2 then
                            queued[ft] = true
                            queue[#queue + 1] = ft
                        end
                    end
                else
                    errors[name] = tostring(err)
                end
            end
        end
    end

    json.dump_file("sdk_types.json", { generated = os.date("%Y-%m-%d %H:%M:%S"), count = 0, types = database, errors = errors }, 1)
    -- count after encode for a stable number
    local n = 0
    for _ in pairs(database) do n = n + 1 end
    json.dump_file("sdk_types.json", { generated = os.date("%Y-%m-%d %H:%M:%S"), count = n, types = database, errors = errors }, 1)
    json.dump_file("sdk_types_done.json", { count = n, at = os.date("%H:%M:%S") })
    log.info(string.format("SdkTypeProbe: dumped %d types (queue %d) -> reframework/data/sdk_types.json", n, #queue - head + 1))
    done = true
end)
