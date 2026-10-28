-- P0-d 同时双怪第二槽阶段探针（design doc §3.2）。
-- 只读。区分三个编号：任务槽号(_BossSet 下标)/顺序表游标(_BossSetNoTbl)/EmSetId+UID，
-- 采样第二槽被挡在哪一层：未调度/等条件/等加载/创建失败/已生成不可见。
-- 证据：<game>/reframework/data/rogue_dualslot_probe.json

local QM = "snow.QuestManager"
local samples, saved, ticks = {}, false, 0
local MAX_SAMPLES = 240

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

local function arr_items(list, maxn)
    if not list then return nil end
    local ok, size = pcall(function() return list:get_Count() end)
    if not ok or not size then return nil end
    local out = {}
    for i = 0, math.min(size - 1, maxn or 7) do
        out[#out + 1] = safe(list, "get_Item", i)
    end
    return out
end

local function sample()
    local qm = sdk.get_managed_singleton(QM)
    if not qm then return nil end
    local s = {
        at = os.time(),
        activeQuestNo = safe(qm, "get_ActiveQuestNo"),
        bossSetCount = safe(qm, "get__BossSetCount") or safe(qm, "get_BossSetCount"),
    }
    -- _BossSet（槽位怪种）、_BossSetNoTbl（顺序表）、_BossSetCond（条件）、加载双标志
    s.bossSet = arr_items(safe(qm, "get__BossSet"), 7)
    s.bossSetNoTbl = arr_items(safe(qm, "get__BossSetNoTbl"), 7)
    s.bossSetCond = arr_items(safe(qm, "get__BossSetCond"), 7)
    s.loadStartOk = safe(qm, "get__BossLoadStartOk")
    s.loadDone = safe(qm, "get__BossLoadDone")
    -- 条件判定结果（checkNextEnemyAppearCondition 的当前返回）
    s.nextCond = safe(qm, "checkNextEnemyAppearCondition")
    -- EnemySetInfo 摘要（EmSetId/status/uid 对照）
    local em = sdk.get_managed_singleton("snow.enemy.EnemyManager")
    local list = em and safe(em, "get_EnemySetInfoList")
    local ok, size = list and pcall(function() return list:get_Count() end) or false, nil
    if ok then size = list:get_Count() end
    if ok and size then
        local sets = {}
        for i = 0, math.min(size - 1, 15) do
            local info = safe(list, "get_Item", i)
            if info then
                sets[#sets + 1] = {
                    emSetId = safe(info, "get_EmSetId"),
                    status = safe(info, "get_SetStatus"),
                    uid = safe(info, "get_UniqueId"),
                }
            end
        end
        s.sets = sets
    end
    return s
end

re.on_frame(function()
    if saved then return end
    ticks = ticks + 1
    if ticks % 60 ~= 0 then return end -- 1s
    local s = sample()
    if not s then return end
    -- 只记录状态变化（design doc 调查纪律：状态变化才记录）
    local prev = samples[#samples]
    if prev and json.dump_file then
        -- 粗比较：bossSetNoTbl/count/nextCond 任一变化即记录
        if prev.bossSetCount == s.bossSetCount
            and prev.nextCond == s.nextCond
            and table.concat(prev.bossSetNoTbl or {}, ",") == table.concat(s.bossSetNoTbl or {}, ",") then
            return
        end
    end
    samples[#samples + 1] = s
    if #samples > MAX_SAMPLES then table.remove(samples, 1) end
end)

re.on_draw_ui(function()
    if not imgui.tree_node("Rogue DualSlotProbe") then return end
    imgui.text(#samples .. " state-change samples")
    if imgui.button("Save dual-slot trace now") and not saved then
        saved = true
        json.dump_file("rogue_dualslot_probe.json", { samples = samples }, 2)
        log.info("DualSlotProbe: saved " .. #samples .. " samples")
    end
    imgui.tree_pop()
end)

re.on_script_reset(function()
    if not saved and #samples > 0 then
        json.dump_file("rogue_dualslot_probe.json", { samples = samples }, 2)
    end
end)
