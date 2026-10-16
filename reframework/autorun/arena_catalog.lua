-- Read-only capture of the installed game's arena/expedition quest templates.
local done, frames = false, 0
local function fields(obj)
    if not obj then return nil end
    local result = {}
    for _, field in ipairs(obj:get_type_definition():get_fields()) do
        if not field:is_static() then
            local name = field:get_name()
            local value = obj:get_field(name)
            if type(value) == "number" or type(value) == "boolean" or type(value) == "string" then
                result[name] = value
            elseif value and field:get_type():get_full_name():find("[]", 1, true) then
                local elements = {}
                for i = 0, value:get_size() - 1 do
                    elements[i + 1] = value:call("Get", i)
                end
                result[name] = elements
            end
        end
    end
    return result
end
re.on_frame(function()
    if done then return end
    frames = frames + 1
    if frames % 300 ~= 0 then return end
    local manager = sdk.get_managed_singleton("snow.QuestManager")
    if not manager then return end
    local dict = manager:get_field("_QuestDataDictionary")
    if not dict then return end
    local entries = dict:get_field("_entries")
    if not entries then return end
    local ok, err = pcall(function()
        local result = {}
        for _, entry in ipairs(entries:get_elements()) do
            local quest = entry:get_field("value")
            if quest then
                local normal = quest:call("get_RawNormal")
                if normal then
                    local map = normal:get_field("_MapNo")
                    local kind = normal:get_field("_QuestType")
                    if map == 10 or kind == 32 then
                        result[#result + 1] = {
                            id = entry:get_field("key"),
                            normal = fields(normal),
                            enemy = fields(quest:call("get_RawEnemy"))
                        }
                    end
                end
            end
        end
        if #result > 0 then
            json.dump_file("arena_catalog.json", result)
            log.info("ArenaCatalog: captured " .. #result .. " templates")
            done = true
        end
    end)
    if not ok then
        log.error("ArenaCatalog: " .. tostring(err))
        done = true
    end
end)
