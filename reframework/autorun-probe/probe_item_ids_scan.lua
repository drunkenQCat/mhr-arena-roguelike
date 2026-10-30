-- Scan item id neighborhood for seeds using ItemData:getName().
local wc=require("webconsole")
local r={kind="run_script",script="probe_seed_scan.lua",epoch=wc.epoch(),session=wc.session_id(),verdict="FAIL"}
local function publish(v,err) r.verdict=v; if err then r.error=tostring(err) end wc.publish_probe(json.dump_string(r)) end
local ADD="tryAddGameItem(snow.data.ContentsIdSystem.ItemId, System.Int32)"
local ok,e=pcall(function()
 local dm=sdk.get_managed_singleton("snow.data.DataManager")
 local pouch=dm:call("getItemPouch")
 local function nameOf(id)
  local okA=pcall(function() pouch:call(ADD,id,1) end)
  if not okA then return "ERR" end
  local slot=pouch:call("findInventoryData",id)
  if not slot or slot:call("get_Count")<=0 then return "not-added" end
  local nm="?"
  local okD,data=pcall(function() return slot:call("getItemData") end)
  if okD and data then
   local okN,v=pcall(function() return data:call("getName") end)
   nm=okN and tostring(v) or "nameErr"
  end
  local n=slot:call("get_Count")
  pcall(function() slot:call("sub",n,false) end)
  return nm
 end
 local out={}
 for id=68157905,68157940 do out[tostring(id)]=nameOf(id) end
 r.names=out
 publish("PASS")
end)
if not ok then publish("ERROR",e) end
