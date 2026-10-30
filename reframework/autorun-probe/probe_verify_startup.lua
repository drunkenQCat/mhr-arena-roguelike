-- Verify startup equip + pouch isolation + buff fields (acceptance helper).
local wc=require("webconsole")
local r={kind="run_script",script="probe_verify_startup.lua",epoch=wc.epoch(),session=wc.session_id(),verdict="FAIL"}
local function publish(v,err) r.verdict=v; if err then r.error=tostring(err) end wc.publish_probe(json.dump_string(r)) end
local ok,e=pcall(function()
 local dm=sdk.get_managed_singleton("snow.data.DataManager")
 local edm=sdk.get_managed_singleton("snow.data.EquipDataManager")
 local box=dm:call("getEquipBox")
 local list=box:get_field("_WeaponArmorInventoryList")
 local pack=edm:call("get_PlEquipPack")
 local arr=pack:get_field("_InventoryIndexList")
 local worn={}
 for i=0,7 do
  local idx=arr:call("get_Item",i)
  local entry=idx>=0 and list:call("get_Item",idx) or nil
  worn[i+1]=entry and {idType=entry:get_field("_IdType"),idVal=entry:get_field("_IdVal"),
    name=(function() local okn,n=pcall(function() return entry:call("getName") end) return okn and tostring(n) or "?" end)()} or -1
 end
 r.worn=worn
 local pouch=dm:call("getItemPouch")
 local counts={}
 for _,t in ipairs({0,1,2,3,4}) do
  local lists=pouch:call("getInventoryDataList",t)
  local n=lists:call("get_Count")
  local total=0
  for i=0,n-1 do
   local s=lists:call("get_Item",i)
   local c=s:call("get_Count")
   if type(c)=="number" and c>0 then total=total+c end
  end
  counts["type"..t]=total
 end
 r.pouchCounts=counts
 local pm=sdk.get_managed_singleton("snow.player.PlayerManager")
 local pl=pm and pm:call("findMasterPlayer")
 local pd=pl and pl:call("get_PlayerData")
 r.buffFields=pd and {atk=pd:get_field("_AtkUpAlive"), def=pd:get_field("_DefUpAlive")} or nil
 local okF,f=pcall(function() return json.load_file("mhw_rogue_startup_state.json") end)
 r.stateFile=okF and f or tostring(f)
 publish("PASS")
end)
if not ok then publish("ERROR",e) end
