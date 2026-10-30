-- Verify this run's ultimate-drop grant (Bone S Helm 0x0C100093) is cleaned.
local wc=require("webconsole")
local r={kind="run_script",script="probe_grant_check2.lua",epoch=wc.epoch(),session=wc.session_id(),verdict="FAIL",at="start"}
local function publish(v,err) r.verdict=v; if err then r.error=tostring(err).." @ "..tostring(r.at) end wc.publish_probe(json.dump_string(r)) end
local ok,e=pcall(function()
 local id=202375315 -- 0x0C100093 Bone S Helm
 r.at="pack"
 local edm=sdk.get_managed_singleton("snow.data.EquipDataManager")
 local pack=edm:call("get_PlEquipPack")
 local arr=pack:get_field("_InventoryIndexList")
 local dm=sdk.get_managed_singleton("snow.data.DataManager")
 local box=dm:call("getEquipBox")
 local list=box:get_field("_WeaponArmorInventoryList")
 r.at="worn"
 local worn={}
 for i=0,7 do
  local idx=arr:call("get_Item",i)
  local entry=(idx~=nil and idx>=0) and list:call("get_Item",idx) or nil
  worn[i+1]=entry and entry:get_field("_IdVal") or -1
 end
 r.wornIdVals=worn
 r.at="scan"
 local cnt=list:call("get_Count")
 local scanFound=false
 for i=0,cnt-1 do
  local e0=list:call("get_Item",i)
  if e0 and e0:get_field("_IdVal")==id and e0:get_field("_IdType")==2 then scanFound=true break end
 end
 r.scanFound=scanFound
 r.boxEntries=cnt
 r.at="statefile"
 local sf=json.load_file("mhw_rogue_startup_state.json")
 r.stateFile=sf and {active=sf.active, grantedCount=(sf.granted and #sf.granted or 0)} or nil
 r.at="done"
 publish((not scanFound) and "PASS" or "FAIL")
end)
if not ok then publish("ERROR",e) end

