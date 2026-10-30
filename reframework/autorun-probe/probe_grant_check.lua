-- Check the ultimate-drop grant (Bone S Vambraces 0x0C300093) is cleaned from the box.
local wc=require("webconsole")
local r={kind="run_script",script="probe_grant_check.lua",epoch=wc.epoch(),session=wc.session_id(),verdict="FAIL",at="start"}
local function publish(v,err) r.verdict=v; if err then r.error=tostring(err).." @ "..tostring(r.at) end wc.publish_probe(json.dump_string(r)) end
local ok,e=pcall(function()
 local dm=sdk.get_managed_singleton("snow.data.DataManager")
 r.at="dm"
 local box=dm:call("getEquipBox")
 r.at="box"; r.box=box~=nil
 local td=box:get_type_definition()
 r.at="td"
 local id=204472467 -- 0x0C300093 Bone S Vambraces (gacha_4 grant this run)
 local m=td:get_method("findInventory(snow.data.DataDef.PlArmorId)")
 r.at="spell-space"
 local m2=td:get_method("findInventory(snow.data.DataDef.PlArmorId,snow.data.EquipmentInventoryData)")
 r.at="spell-nospace"
 r.spells={space=(m~=nil), nospace=(m2~=nil)}
 local method=m or m2
 assert(method,"findInventory(PlArmorId) overload missing")
 r.at="call"
 local okc,cout=pcall(function() return box:call(method,id) end)
 r.callErr=okc and nil or tostring(cout)
 local found=okc and cout or nil
 r.at="found"; r.found=(found~=nil)
 r.at="scan"
 local list0=box:get_field("_WeaponArmorInventoryList")
 local cnt=list0:call("get_Count")
 local scanFound=false
 for i=0,cnt-1 do
  local e0=list0:call("get_Item",i)
  if e0 and e0:get_field("_IdVal")==id and e0:get_field("_IdType")==2 then scanFound=true break end
 end
 r.scanFound=scanFound
 r.boxEntries=cnt
 r.at="pack"
 local edm=sdk.get_managed_singleton("snow.data.EquipDataManager")
 local pack=edm:call("get_PlEquipPack")
 local arr=pack:get_field("_InventoryIndexList")
 local list=box:get_field("_WeaponArmorInventoryList")
 r.at="worn"
 local worn={}
 for i=0,7 do
  local idx=arr:call("get_Item",i)
  local entry=(idx~=nil and idx>=0) and list:call("get_Item",idx) or nil
  worn[i+1]=entry and entry:get_field("_IdVal") or -1
 end
 r.wornIdVals=worn
 r.at="statefile"
 local sf=json.load_file("mhw_rogue_startup_state.json")
 r.stateFile=sf and {active=sf.active, grantedCount=(sf.granted and #sf.granted or 0)} or nil
 r.at="done"
 publish(found and "FAIL" or "PASS")
end)
if not ok then publish("ERROR",e) end
