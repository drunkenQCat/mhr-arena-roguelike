-- Explicit test weapon grant. Native EquipBox insertion, no replacement/equipment swap.
-- Weapon ID reference: strokkk/MonsterHunterRiseModding, Weapon IDs (LS).
local WEAPON=0x085001B8 -- W_LongSword_440: R10 Abyssal Flicker, base attack 340.
local ADD="tryAddGameItem(snow.data.ContentsIdSystem.WeaponId, snow.data.EquipmentInventoryData, System.Boolean)"
local FIND="findInventory(snow.data.ContentsIdSystem.WeaponId)"
local pending,locked=false,false
local status="Adds one R10 Abyssal Flicker (340 attack) to equipment box."
local function grant()
    local qm=sdk.get_managed_singleton("snow.QuestManager")
    local stage=sdk.get_managed_singleton("snow.stage.StageManager")
    assert(qm and stage and not stage:call("get_IsQuestOnline"),"Offline only")
    assert(not qm:call("isActiveQuest"),"Return to village with no accepted quest first")
    local dm=sdk.get_managed_singleton("snow.data.DataManager")
    local box=dm and dm:call("getEquipBox")
    assert(box,"Equipment box unavailable")
    assert(box:get_type_definition():get_method(ADD),"Native weapon grant overload missing")
    assert(box:get_type_definition():get_method(FIND),"Native weapon lookup overload missing")
    local existing=box:call(FIND,WEAPON)
    if existing then status="Already owned: Abyssal Flicker. Equip it from your item box.";return end
    local slot=box:call("getEmptyWeaponArmorInventoryFirst")
    assert(slot,"Equipment box is full")
    assert(slot:get_field("_IdType")==0,"Refusing to overwrite an occupied equipment slot")
    local before=box:call("countWeaponArmorEmptyNum")
    assert(type(before)=="number" and before>0,"No verified free equipment space")
    locked=true -- Do not retry an ambiguous native write automatically.
    json.dump_file("rogue_test_weapon_result.json",{event="before",weaponId=WEAPON,emptyBefore=before,at=os.time()},2)
    local result=box:call(ADD,WEAPON,slot,false)
    local id=slot:get_field("_IdVal")
    local kind=slot:get_field("_IdType")
    local after=box:call("countWeaponArmorEmptyNum")
    local verified=result~=nil and id==WEAPON and kind==1 and after==before-1
    json.dump_file("rogue_test_weapon_result.json",{event="after",weaponId=WEAPON,actualId=id,idType=kind,
        returned=result~=nil,emptyBefore=before,emptyAfter=after,verified=verified,at=os.time()},2)
    assert(verified,"Grant result uncertain; inspect equipment box. No repeat in this session.")
    status="Added: R10 Abyssal Flicker (340 attack). Item Box > Change Equipment."
end
re.on_frame(function()
    if pending then
        pending=false
        local ok,err=pcall(grant)
        if not ok then status=tostring(err) end
    end
end)
re.on_draw_ui(function()
    if imgui.tree_node("TEST: R10 Long Sword") then
        imgui.text(status)
        if imgui.button("Add R10 Long Sword: Abyssal Flicker") then
            if locked then status="Attempt already recorded. Check your equipment box; no repeated grant."
            else pending=true end
        end
        imgui.tree_pop()
    end
end)
