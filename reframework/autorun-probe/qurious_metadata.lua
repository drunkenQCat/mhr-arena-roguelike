local wc=require('webconsole')
local report={script='qurious_metadata.lua',epoch=wc.epoch(),verdict='PASS',types={}}
local queue={'snow.player.PlayerData','snow.player.PlayerBase','snow.data.EquipData','snow.player.PlayerRequestEquipsData','snow.player.PlayerSkillList','snow.equip.PlEquipPack','snow.data.EquipDataManager','snow.player.PlayerManager','snow.player.PlayerQuestBase','snow.data.ArmorElementRegParam','snow.data.ArmorBaseData','snow.data.PlSkillData','snow.data.CustomBuildupModule','snow.data.ArmorCustomBuildupData','snow.data.WeaponCustomBuildupData','snow.data.FacilityDataManager','snow.data.DataShortcut','snow.gui.fsm.smithy.GuiCustomBuildup','snow.data.EquipmentInventoryData','snow.data.EquipmentInventoryData.CustomBuildupResult','snow.data.ArmorData','snow.data.DataDef.CustomBuildupId','snow.data.DataDef.CustomBuildupType','snow.data.CustomBuildupResultData'}
local seen={}
local function add(name) if name and name:lower():find('custombuildup') and not seen[name] then queue[#queue+1]=name end end
local ok,err=pcall(function()
 local head=1
 while head<=#queue and head<150 do
  local name=queue[head];head=head+1
  if not seen[name] then
   seen[name]=true
   local td=sdk.find_type_definition(name)
   if td then
    local entry={fields={},methods={}};report.types[name]=entry
    for _,f in ipairs(td:get_fields()) do
     local ft=f:get_type():get_full_name();add(ft)
     local row={name=f:get_name(),type=ft,static=f:is_static()}
     if f:is_static() then local success,v=pcall(function() return f:get_data(nil) end);if success and (type(v)=='number' or type(v)=='boolean' or type(v)=='string')then row.value=v end end
     entry.fields[#entry.fields+1]=row
    end
    for _,m in ipairs(td:get_methods()) do
     local rt=m:get_return_type():get_full_name();add(rt)
     local row={name=m:get_name(),address=tostring(m:get_function()),ret=rt,static=m:is_static(),params={},paramNames=m:get_param_names()}
     for _,pt in ipairs(m:get_param_types() or {})do local pn=pt:get_full_name();row.params[#row.params+1]=pn;add(pn) end
     entry.methods[#entry.methods+1]=row
    end
   end
  end
 end
end)
if not ok then report.verdict='ERROR';report.error=tostring(err) end
wc.publish_probe(json.dump_string(report))
