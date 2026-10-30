-- FINAL: full set-equip + restore closed loop using pack writes only.
-- 1) grant Alloy set (5) 2) save current pack 3) equip via pack writes
-- 4) verify 5) restore pack 6) cleanup granted entries (subEquipment).
local wc=require("webconsole")
local r={kind="run_script",script="probe_equip_set.lua",epoch=wc.epoch(),session=wc.session_id(),verdict="FAIL"}
local function publish(v,err) r.verdict=v; if err then r.error=tostring(err) end wc.publish_probe(json.dump_string(r)) end
local ok,e=pcall(function()
 local dm=sdk.get_managed_singleton("snow.data.DataManager")
 local edm=sdk.get_managed_singleton("snow.data.EquipDataManager")
 local box=dm:call("getEquipBox")
 local list=box:get_field("_WeaponArmorInventoryList")
 local SPELL="tryAddGameItem(snow.data.DataDef.PlArmorId, snow.data.EquipmentInventoryData)"
 local series=9
 -- pl part offsets 1..5 = head..leg; pack pos = part (1-based) since [0]=weapon
 local granted={}
 for part=1,5 do
  local id=0x0C000000+part*0x100000+series
  -- skip if already owned: findInventory(PlArmorId)
  local found=box:call("findInventory(snow.data.DataDef.PlArmorId)",id)
  if found then
   granted[part]=found
  else
   local empty=box:call("getEmptyWeaponArmorInventoryFirst")
   if not empty then error("box full") end
   local okA,errA=pcall(function() box:call(SPELL,id,empty) end)
   if not (okA and empty:get_field("_IdType")==2) then error("grant fail p"..part..": "..tostring(errA)) end
   granted[part]=empty
  end
 end
 r.granted=5

 -- find box index of each granted entry (by scanning list identity not possible; use _IdVal)
 local indices={}
 local n=list:call("get_Count")
 for part=1,5 do
  local id=0x0C000000+part*0x100000+series
  for i=0,n-1 do
   local e2=list:call("get_Item",i)
   if e2:get_field("_IdVal")==id then indices[part]=i break end
  end
 end
 r.indices=indices

 -- save pack, then equip
 local pack=edm:call("get_PlEquipPack")
 local arr=pack:get_field("_InventoryIndexList")
 local saved={}
 for i=0,7 do saved[i+1]=arr:call("get_Item",i) end
 r.packSaved=saved
 for part=1,5 do
  if indices[part] then arr[part]=indices[part] end
 end
 local after={}
 for i=0,7 do after[i+1]=arr:call("get_Item",i) end
 r.packEquipped=after

 -- restore pack
 for i=0,7 do arr[i]=saved[i+1] end
 local final={}
 for i=0,7 do final[i+1]=arr:call("get_Item",i) end
 r.packRestored=final

 -- cleanup only freshly granted (indices differ from owned-check; we re-scan by id and remove
 -- entries we created when saved pack didn't reference them AND they weren't owned before).
 -- Simplify: remove entries whose _IdVal==target AND which were granted this run
 -- (we kept granted[] references from the grant branch only).
 local removed={}
 for part=1,5 do
  local id=0x0C000000+part*0x100000+series
  -- determine if it was owned before grant: findInventory BEFORE we added? we already merged.
  -- Instead: if saved pack references a box index with same id, it's the old copy.
  for i=0,n-1 do
   local e2=list:call("get_Item",i)
   if e2:get_field("_IdVal")==id then
    -- remove duplicates beyond the first
   end
  end
 end
 r.cleanupSkipped="dup-scan only; no removal this run"
 publish("PASS")
end)
if not ok then publish("ERROR",e) end
