-- P0-c Nando 难度链探针（design doc §3.1 的 5 个追踪点）。
-- 只读。目的：对比"首进怪"与"追加/续波怪"的难度解析路径，找第一个偏离点。
-- 用法：autorun 放置后正常跑一轮 M2a/肉鸽，每 2 秒采样一次；
--       结束时在 "Rogue NandoProbe" 面板点 Save，或 600 帧自动滚动保留最新。
-- 证据：<game>/reframework/data/rogue_nando_probe.json

local QM = "snow.QuestManager"
local EM = "snow.enemy.EnemyManager"
local samples, hooks, saved = {}, {}, false
local ticks = 0
local MAX_SAMPLES = 180

local function record(event, detail)
    hooks[#hooks + 1] = { at = os.time(), event = event, detail = detail }
    if #hooks > 60 then table.remove(hooks, 1) end
end

-- 显式参数版（luaparse 5.1 检查器不支持普通函数中的 ...；调用点最多 3 参）
local function safe0(obj, method)
    if not obj then return nil end
    local ok, v = pcall(function() return obj:call(method) end)
    return ok and v or nil
end
local function safe1(obj, method, a)
    if not obj then return nil end
    local ok, v = pcall(function() return obj:call(method, a) end)
    return ok and v or nil
end
local function safe2(obj, method, a, b)
    if not obj then return nil end
    local ok, v = pcall(function() return obj:call(method, a, b) end)
    return ok and v or nil
end
local function safe3(obj, method, a, b, c)
    if not obj then return nil end
    local ok, v = pcall(function() return obj:call(method, a, b, c) end)
    return ok and v or nil
end

local function dump_nando(em_set_id)
    local qm = sdk.get_managed_singleton(QM)
    if not qm then return nil end
    local nando = safe(qm, "getQuestEnemyNando(System.Int32)", em_set_id)
    if not nando then return { emSetId = em_set_id, nando = "unavailable" } end
    local out = { emSetId = em_set_id }
    for _, f in ipairs({ "Vital", "Attack", "NandoWave", "Scale", "ScaleWave", "Stamina" }) do
        out[f] = safe(nando, "get_" .. f)
    end
    return out
end

local function sample_enemies()
    local em = sdk.get_managed_singleton(EM)
    if not em then return nil end
    local count = safe(em, "getBossEnemyCount")
    if not count then return nil end
    local list = {}
    for i = 0, count - 1 do
        local e = safe(em, "getBossEnemy", i)
        if e then
            local row = {
                emType = safe(e, "get_EmTypeIndex"),
                uid = safe(e, "get_UniqueId"),
                vitalNandoWave = safe(e, "get_VitalNandoWave"),
                hpMaxVital = safe(e, "getHpMaxVital", 0),
                baseScale = safe(e, "get_BaseScale"),
                randomScale = safe(e, "get_RandomScale"),
                totalScale = safe(e, "get_TotalScale"),
            }
            -- 每个角色的难度倍率（Hp/Base 组合）
            row.rateHpBase = safe(e, "getDifficultyRateVital", 0, 1, 0)
            list[#list + 1] = row
        end
    end
    return list
end

local function sample_sets()
    local em = sdk.get_managed_singleton(EM)
    if not em then return nil end
    local list = safe(em, "get_EnemySetInfoList")
    if not list then return nil end
    local ok, size = pcall(function() return list:get_Count() end)
    if not ok or not size then return nil end
    local out = {}
    for i = 0, math.min(size - 1, 15) do
        local info = safe(list, "get_Item", i)
        if info then
            out[#out + 1] = {
                emSetId = safe(info, "get_EmSetId"),
                status = safe(info, "get_SetStatus"),
                uid = safe(info, "get_UniqueId"),
                repopNum = safe(info, "get_RepopNum"),
            }
        end
    end
    return out
end

re.on_frame(function()
    if saved then return end
    ticks = ticks + 1
    if ticks % 120 ~= 0 then return end -- ~2s
    local qm = sdk.get_managed_singleton(QM)
    if not qm then return end

    local boss_set_count = safe(qm, "get__BossSetCount") or safe(qm, "get_BossSetCount")
    local sample = {
        at = os.time(),
        questNo = safe(qm, "get_ActiveQuestNo"),
        bossSetCount = boss_set_count,
        enemies = sample_enemies(),
        sets = sample_sets(),
    }
    -- 首个出场的怪附带 Nando 对象采样（§3.1 追踪点 2）
    local enemies = sample.enemies
    if enemies and enemies[1] and enemies[1].emSetId ~= nil then
        sample.nando = dump_nando(enemies[1].emSetId)
    end
    samples[#samples + 1] = sample
    if #samples > MAX_SAMPLES then table.remove(samples, 1) end
end)

-- 出怪钩子：记录 createEnemySetInfo 的返回（新 EmSetId）——追踪点 1
local em_td = sdk.find_type_definition(EM)
local create_method = em_td and em_td:get_method("createEnemySetInfo")
if create_method then
    sdk.hook(create_method, function() end, function(retval)
        local info = sdk.to_managed_object(retval)
        record("createEnemySetInfo", {
            emSetId = info and safe(info, "get_EmSetId"),
            uid = info and safe(info, "get_UniqueId"),
        })
        return retval
    end)
end

re.on_draw_ui(function()
    if not imgui.tree_node("Rogue NandoProbe") then return end
    imgui.text(#samples .. " samples / " .. #hooks .. " hook events")
    if imgui.button("Save nando trace now") and not saved then
        saved = true
        json.dump_file("rogue_nando_probe.json", { samples = samples, hooks = hooks }, 2)
        log.info("NandoProbe: saved " .. #samples .. " samples")
    end
    imgui.tree_pop()
end)

re.on_script_reset(function()
    if not saved and #samples > 0 then
        json.dump_file("rogue_nando_probe.json", { samples = samples, hooks = hooks }, 2)
    end
end)
