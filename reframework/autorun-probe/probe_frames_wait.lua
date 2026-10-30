-- Wait 120 frames, then re-read pack head slot. Survivor test for pack writes.
local wc=require("webconsole")
local r={kind="run_script",script="probe_frames_wait.lua",epoch=wc.epoch(),session=wc.session_id(),verdict="FAIL"}
local function publish(v,err) r.verdict=v; if err then r.error=tostring(err) end wc.publish_probe(json.dump_string(r)) end
local edm=sdk.get_managed_singleton("snow.data.EquipDataManager")
local frames=0
local done=false
re.on_frame(function()
 if done then return end
 frames=frames+1
 if frames<120 then return end
 local pack=edm:call("get_PlEquipPack")
 local arr=pack:get_field("_InventoryIndexList")
 local dm=sdk.get_managed_singleton("snow.data.DataManager")
 local box=dm:call("getEquipBox")
 local list=box:get_field("_WeaponArmorInventoryList")
 local idx=arr:call("get_Item",1)
 local entry=idx>=0 and list:call("get_Item",idx) or nil
 local name="?"
 if entry then local okn,n=pcall(function() return entry:call("getName") end) name=okn and tostring(n) or "?" end
 r.head={index=idx, idVal=entry and entry:get_field("_IdVal") or nil, name=name}
 done=true
 publish(name=="骨制头盔" and "PASS" or "FAIL")
end)
