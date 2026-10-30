-- Read-only equipment/enum/buff survey for the roguelike wiring research.
-- Run with: node cli/mhr.mjs game run-script reframework/autorun-probe/probe_equip_read.lua --timeout 30 --json
-- No mutation: reads singletons, enums, current worn equipment, box summary,
-- PlayerData buff fields and method-overload counts. Full PlArmorId enum is
-- dumped to probe_equip_read_plarmorid.json for offline ID mapping.
local wc=require("webconsole")
local r={kind="run_script",script="probe_equip_read.lua",epoch=wc.epoch(),session=wc.session_id(),verdict="FAIL"}
local function publish(v,err) r.verdict=v; if err then r.error=tostring(err) end wc.publish_probe(json.dump_string(r)) end
local function num(v) return type(v)=="number" and v or nil end
local ok,e=pcall(function()
 local st=sdk.get_managed_singleton("snow.stage.StageManager")
 assert(not st:call("get_IsQuestOnline"),"offline only")
 local dm=sdk.get_managed_singleton("snow.data.DataManager")
 assert(dm,"no DataManager")
 local box=dm:call("getEquipBox")
 r.equipBox=box~=nil
 local edm=sdk.get_managed_singleton("snow.data.EquipDataManager")
 r.equipDataManager=edm~=nil

 local function enumAll(path)
  local td=sdk.find_type_definition(path)
  if not td then return nil,"type missing" end
  local out={}
  for _,f in ipairs(td:get_fields()) do
   if f:is_static() then
    local ok2,v=pcall(f.get_data,f,nil)
    if ok2 and type(v)=="number" then out[tostring(f:get_name())]=v end
   end
  end
  return out
 end
 local function count(t) local c=0; for _ in pairs(t or {}) do c=c+1 end return c end

 r.enum_PlEquipTypes=enumAll("snow.equip.PlEquipTypes")
 r.enum_EquipPartsType=enumAll("snow.data.EquipData.EquipPartsType")
 r.enum_ArmorPartsTypes=enumAll("snow.data.ArmorData.PartsTypes")
 r.enum_InventoryType=enumAll("snow.data.InventoryData.InventoryType")
 r.enum_EquipBoxInventoryType=enumAll("snow.data.EquipBox.InventoryType")
 local armorIds,errA=enumAll("snow.data.DataDef.PlArmorId")
 if armorIds then
  r.plArmorId_total=count(armorIds)
  local pick={}
  for name,v in pairs(armorIds) do
   if name=="A_None" or name=="A_Error" or name:lower():find("bone") or name:lower():find("alloy") then pick[name]=v end
  end
  r.plArmorId_pick=pick
  json.dump_file("probe_equip_read_plarmorid.json",armorIds,2)
 else r.plArmorId_err=tostring(errA) end

 if edm then
  local function snapshot(obj)
   if not obj then return nil end
   local ok2,idT=pcall(function() return obj:get_field("_IdType") end)
   local ok3,idV=pcall(function() return obj:get_field("_IdVal") end)
   return {idType=ok2 and num(idT) or tostring(idT), idVal=ok3 and num(idV) or tostring(idV)}
  end
  local okW,w=pcall(function() return edm:call("getEquipWeaponData") end)
  r.weapon=okW and snapshot(w) or ("ERR "..tostring(w))
  r.armor={}
  for name,val in pairs(r.enum_ArmorPartsTypes or {}) do
   local ok2,a=pcall(function() return edm:call("getEquipArmorData",val) end)
   r.armor[tostring(name)]=ok2 and snapshot(a) or ("ERR "..tostring(a))
  end
  local okT,t=pcall(function() return edm:call("getEquipTalismanData") end)
  r.talisman=okT and snapshot(t) or ("ERR "..tostring(t))
  local okP,pack=pcall(function() return edm:call("get_PlEquipPack") end)
  if okP and pack then
   local okI,elems=pcall(function() return pack:get_field("_InventoryIndexList"):get_elements() end)
   if okI and type(elems)=="table" then
    local first={}
    for i=1,math.min(#elems,14) do first[i]=elems[i] end
    r.plEquipPackIndices=first
   else r.plEquipPackIndicesErr=tostring(elems) end
  else r.plEquipPackErr=tostring(pack) end
  local counts={}
  for _,m in ipairs(edm:get_type_definition():get_methods()) do
   local n=m:get_name()
   if n=="changeEquip" or n=="removeEquip" or n=="saveToBackup" or n=="loadFromBackup" or n=="applyEquipMySet" or n=="equipPlDefaultData" or n=="reloadPlayerModel" then
    counts[n]=(counts[n] or 0)+1
   end
  end
  r.edmMethodOverloads=counts
 end

 if box then
  local list=box:get_field("_WeaponArmorInventoryList")
  local n=num(list:call("get_Count")) or 0
  r.box={entries=n, emptyCount=num(box:call("countWeaponArmorEmptyNum")), tryAddGameItemOverloads=0}
  local sample={}
  for i=0,math.min(n,24)-1 do
   local e2=list:call("get_Item",i)
   sample[#sample+1]={idType=num(e2:get_field("_IdType")),idVal=num(e2:get_field("_IdVal"))}
  end
  r.box.sample=sample
  for _,m in ipairs(box:get_type_definition():get_methods()) do
   if m:get_name()=="tryAddGameItem" then r.box.tryAddGameItemOverloads=r.box.tryAddGameItemOverloads+1 end
  end
 end

 local pm=sdk.get_managed_singleton("snow.player.PlayerManager")
 local pl=pm and pm:call("findMasterPlayer")
 r.masterPlayer=pl~=nil
 local pd=pl and pl:call("get_PlayerData")
 r.playerData=pd~=nil
 if pd then
  local ptd=pd:get_type_definition()
  local fields={}
  for _,name in ipairs({"_AtkUpAlive","_DefUpAlive","_AtkUpBuffSecond","_DefUpBuffSecond","_AtkUpItemSecond","_DefUpItemSecond","_CriticalRate","_Attack","_Defence"}) do
   local f=ptd:get_field(name)
   if f then
    local ok2,v=pcall(function() return pd:get_field(name) end)
    fields[name]=ok2 and v or tostring(v)
   else fields[name]="<missing>" end
  end
  r.playerBuffFields=fields
  local okC,c=pcall(function() return pl:call("calcTotalAttack") end)
  r.calcTotalAttack=okC and num(c) or tostring(c)
 end
 local mbd=sdk.find_type_definition("snow.equip.MainWeaponBaseData")
 r.mainWeaponBaseData=mbd and {exists=true, criticalRateGetter=(mbd:get_method("get_CriticalRate")~=nil)} or {exists=false}

 publish("PASS")
end)
if not ok then publish("ERROR",e) end
