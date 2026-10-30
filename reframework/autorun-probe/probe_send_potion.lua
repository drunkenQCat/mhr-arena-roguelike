-- Grant potion into pouch, send to item box via DataManager.sendInventory, verify, revert.
local wc=require("webconsole")
local r={kind="run_script",script="probe_send_potion.lua",epoch=wc.epoch(),session=wc.session_id(),verdict="FAIL"}
local function publish(v,err) r.verdict=v; if err then r.error=tostring(err) end wc.publish_probe(json.dump_string(r)) end
local POTION=0x04100006
local NORMAL=1
local BOX=65536
local ADD="tryAddGameItem(snow.data.ContentsIdSystem.ItemId, System.Int32)"
local PRE="checkSendInventoryStatus(snow.data.ItemInventoryData, snow.data.InventoryData.InventoryType)"
local SEND="sendInventory(snow.data.ItemInventoryData, snow.data.InventoryData.InventoryType)"
local function publish2() end
local ok,e=pcall(function()
 local dm=sdk.get_managed_singleton("snow.data.DataManager")
 local pouch=dm:call("getItemPouch")
 local box=dm:call("getItemBox")
 -- baseline box count of potion
 local b0=box:call("findInventoryData",POTION)
 local boxBefore=b0 and b0:call("get_Count") or 0
 r.boxBefore=boxBefore
 -- grant 3 potions
 local okA,errA=pcall(function() pouch:call(ADD,POTION,3) end)
 r.grant={ok=okA,err=okA and nil or tostring(errA)}
 local lists=pouch:call("getInventoryDataList",NORMAL)
 local slot=pouch:call("findInventoryData",POTION)
 r.slotCount=slot and slot:call("get_Count") or -1
 if slot and slot:call("get_Count")>0 then
  local okP,pv=pcall(function() return dm:call(PRE,slot,BOX) end)
  r.precheck={ok=okP,val=okP and tostring(pv) or tostring(pv)}
  local maxN=dm:call("getMaxNumberToSend(snow.data.ItemInventoryData, snow.data.InventoryData.InventoryType)",slot,BOX)
  r.maxToSend=tostring(maxN)
  local okS,sv=pcall(function() return dm:call(SEND,slot,BOX) end)
  r.send={ok=okS,ret=okS and tostring(sv) or tostring(sv)}
  local after=slot and slot:call("get_Count") or -1
  r.slotAfter=after
  local b1=box:call("findInventoryData",POTION)
  r.boxAfter=b1 and b1:call("get_Count") or 0
  -- revert to restore pouch
  local okR,rv=pcall(function() return dm:call("revertSendInventory") end)
  r.revert={ok=okR,ret=okR and tostring(rv) or tostring(rv)}
  local slot2=pouch:call("findInventoryData",POTION)
  r.slotAfterRevert=slot2 and slot2:call("get_Count") or 0
  local b2=box:call("findInventoryData",POTION)
  r.boxAfterRevert=b2 and b2:call("get_Count") or 0
 end
 publish("PASS")
end)
if not ok then publish("ERROR",e) end
