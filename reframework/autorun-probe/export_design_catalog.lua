-- Read-only catalogue export. Scratch objects are never inserted into equipment/pouch.
local wc=require("webconsole")
local rows,errors={},{}
local function enumerate(typeName,kind)
 local t=sdk.find_type_definition(typeName)
 if not t then errors[#errors+1]=typeName.." unavailable";return end
 local before=#rows
 local seen={}
 for _,f in ipairs(t:get_fields()) do
  if f:is_static() then
   local id=f:get_data(nil)
   if type(id)=="number" and id>0 and not seen[id] then
    seen[id]=true
    local ok,name=pcall(function()
     if kind=="decoration" then
      local o=sdk.create_instance("snow.data.DecorationsData"):add_ref()
      o:call(".ctor(snow.equip.DecorationsId)",id)
      if o:call("isHyakuryu") then return nil end
      return o:call("getName")
     elseif kind=="item" then
      local shortcut=sdk.find_type_definition("snow.data.DataShortcut")
      return shortcut:get_method("getName(snow.data.ContentsIdSystem.ItemId)"):call(nil,id)
     else
      local o=sdk.create_instance("snow.data.EquipmentInventoryData"):add_ref()
      o:call(".ctor")
      o:set_field("_IdType",kind=="armor" and 2 or 1)
      o:set_field("_IdVal",id)
      return o:call("getName")
     end
    end)
    if ok and type(name)=="string" and #name>0 then rows[#rows+1]={kind=kind,id=id,name=name} end
   end
  end
 end
 if #rows==before then errors[#errors+1]=kind..": no names resolved; verify native methods for this game version" end
end
enumerate("snow.data.ContentsIdSystem.WeaponId","weapon")
enumerate("snow.data.DataDef.PlArmorId","armor")
enumerate("snow.equip.DecorationsId","decoration")
enumerate("snow.data.ContentsIdSystem.ItemId","item")
json.dump_file("rogue_design_catalog.json",{schema=1,entries=rows,errors=errors},2)
wc.publish_probe(json.dump_string({kind="run_script",script="export_design_catalog.lua",epoch=wc.epoch(),verdict=#rows>0 and "PASS" or "ERROR",count=#rows,errors=errors,file="reframework/data/rogue_design_catalog.json"}))
