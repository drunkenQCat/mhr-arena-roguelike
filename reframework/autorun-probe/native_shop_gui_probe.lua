-- Manual research probe. Not installed by npm build/deploy; never buys or grants items.
-- Metadata APIs: https://cursey.github.io/reframework-book/api/types/REMethodDefinition.html
local SHOP = "snow.gui.fsm.itemshop.GuiItemShopFsmManager"
local FACILITY = "snow.LobbyFacilityUIManager"
local GUI = "snow.gui.GuiManager"
local OPEN_YN = "setOpenYNInfo(System.String, snow.gui.GuiManager.YNInfoUIState, snow.gui.SnowGuiCommonUtility.Segment, System.Boolean, System.Boolean)"
local targets = {
    GUI, FACILITY, SHOP, "snow.gui.fsm.pointshop.GuiPointShopFsmManager",
    "snow.gui.GuiCommonSelectWindow", "snow.gui.GuiCommonYNInfoWindow",
    "snow.gui.GuiOptionWindow", "snow.data.DataManager", "snow.data.FacilityDataManager",
    "snow.data.ItemInventoryData", "snow.data.DisplayItemData", "snow.data.InventoryData",
    "snow.gui.fsm.itemshop.GuiItemShopBuyYNFsmAction",
    "snow.gui.fsm.itemshop.GuiItemShopBuyYNAgainFsmAction",
    "snow.gui.fsm.itemshop.GuiItemShopFsmBuyMenuNumAction",
    "snow.gui.fsm.itemshop.GuiItemShopFsmBuyMenuAction",
    "snow.gui.SnowGuiCommonUtility.NumCursor",
}
local pending, shop_until, yn_until = nil, nil, nil
local status = "Idle: metadata export is read-only; native UI demos are experimental."
local events = {}

local function record(event, detail)
    events[#events + 1] = { at = os.time(), event = event, detail = detail }
    if #events > 40 then table.remove(events, 1) end
    json.dump_file("rogue_native_gui_probe_events.json", { events = events }, 2)
end

local function describe(td)
    local levels = {}
    for _ = 1, 4 do
        if not td then break end
        local row = { name = td:get_full_name(), fields = {}, methods = {} }
        for _, f in ipairs(td:get_fields()) do
            row.fields[#row.fields + 1] = { name = f:get_name(), type = f:get_type():get_full_name(), static = f:is_static() }
        end
        -- Keep EVERY overload; the older selective dump retains just one signature per name.
        for _, m in ipairs(td:get_methods()) do
            local types, names, params = m:get_param_types(), m:get_param_names(), {}
            for i, t in ipairs(types or {}) do params[i] = { name = names and names[i], type = t:get_full_name() } end
            local ret = m:get_return_type()
            row.methods[#row.methods + 1] = { name = m:get_name(), params = params,
                ret = ret and ret:get_full_name(), static = m:is_static() }
        end
        levels[#levels + 1] = row
        td = td:get_parent_type()
    end
    return levels
end

local function export()
    local out = { at = os.time(), runtimeVerified = false, types = {}, instances = {} }
    for _, name in ipairs(targets) do
        local ok, value = pcall(function()
            local td = sdk.find_type_definition(name)
            return td and describe(td) or { missing = true }
        end)
        out.types[name] = ok and value or { error = tostring(value) }
    end
    -- Follow live inventory object TYPES only. Never export item counts, money or save data.
    local dm = sdk.get_managed_singleton("snow.data.DataManager")
    if dm then
        for _, field in ipairs({ "_PlItemBox", "_HandMoney" }) do
            local ok, value = pcall(function()
                local obj = dm:get_field(field)
                return obj and describe(obj:get_type_definition()) or { absent = true }
            end)
            out.instances[field] = ok and value or { error = tostring(value) }
        end
    end
    json.dump_file("rogue_native_gui_metadata.json", out, 2)
    status = "Exported reframework/data/rogue_native_gui_metadata.json"
    record("metadata-exported", { purchaseExecuted = false })
end

local function village()
    local qm, gui = sdk.get_managed_singleton("snow.QuestManager"), sdk.get_managed_singleton(GUI)
    if not qm or not gui or qm:call("isActiveQuest") or not gui:call("IsCanInvokeQuestBoard") then
        error("UI demo requires idle village with no accepted quest or other menu")
    end
    local lobby_stage = sdk.get_managed_singleton("snow.stage.StageManager")
    if not lobby_stage or lobby_stage:call("get_IsQuestOnline") then error("Solo village only") end
    if gui:call("isOpenYNInfo") or gui:call("isOpenSelectInfo") then error("Another native dialog is open") end
    if shop_until or yn_until then error("This probe already owns a UI operation") end
    return gui
end

local function close_owned()
    local own_shop, own_yn = shop_until ~= nil, yn_until ~= nil
    shop_until, yn_until = nil, nil
    if own_yn then
        local gui = sdk.get_managed_singleton(GUI)
        if gui then gui:call("closeYNInfo") end
    end
    if own_shop then
        local facility = sdk.get_managed_singleton(FACILITY)
        if facility then facility:call("deactivateOnly", 4) end -- SceneId.ItemShop in local enum dump
    end
end

re.on_frame(function()
    local ok, err = pcall(function()
        local action = pending
        pending = nil
        if action == "export" then export()
        elseif action == "close" then close_owned(); status = "Probe-owned UI released"
        elseif action == "shop" then
            village()
            if sdk.get_managed_singleton(SHOP) then error("Item shop manager already exists; open it manually and export metadata") end
            local facility = sdk.get_managed_singleton(FACILITY)
            if not facility or not facility:get_type_definition():get_method("activateOnly") then error("Facility API missing") end
            shop_until = os.time() + 15
            facility:call("activateOnly", 4)
            status = "Requested native ItemShop; visual open/close still needs verification"
            record("shop-open-requested", { sceneId = 4, purchaseExecuted = false })
        elseif action == "yn" then
            local gui = village()
            local method = gui:get_type_definition():get_method(OPEN_YN)
            if not method then error("String Y/N overload unavailable; export metadata first") end
            yn_until = os.time() + 30
            method:call(gui, "Roguelike GUI research: confirm this harmless dialog? No purchase.", 0, 50, false, false)
            record("yn-open-requested", { segment = 50, purchaseExecuted = false })
        end
        if yn_until then
            local gui = sdk.get_managed_singleton(GUI)
            if not gui then error("GUI manager disappeared") end
            local result = gui:call("updateYNInfoWindow", 0xaa66032d)
            if result == 0 or result == 1 then
                status = result == 0 and "Native Y/N: YES (no purchase)" or "Native Y/N: NO (no purchase)"
                record("yn-result", { result = result, purchaseExecuted = false })
                close_owned()
            elseif os.time() > yn_until then close_owned(); status = "Y/N demo timed out and closed" end
        end
        if shop_until and os.time() > shop_until then
            close_owned(); status = "Item shop demo timed out and released its facility"
        end
    end)
    if not ok then
        status = tostring(err)
        pcall(close_owned)
        record("probe-error", status)
    end
end)

re.on_draw_ui(function()
    if not imgui.tree_node("Roguelike research: native shop / GUI") then return end
    imgui.text(status)
    imgui.text("Metadata first. Demos: village only; no automatic purchase or PT deduction.")
    if imgui.button("Export native GUI / inventory API metadata") then pending = "export" end
    if imgui.button("EXPERIMENT: open native item shop (15 sec)") then pending = "shop" end
    if imgui.button("EXPERIMENT: native Yes/No dialog (no purchase)") then pending = "yn" end
    if imgui.button("Close only this probe's UI") then pending = "close" end
    imgui.tree_pop()
end)

re.on_script_reset(function() pcall(close_owned) end)
