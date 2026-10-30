-- Dump live quest condition tables and source EnemySetParam key fields.
local wc=require("webconsole")
local r={kind="run_script",script="probe_quest_tables.lua",epoch=wc.epoch(),session=wc.session_id(),verdict="FAIL"}
local function publish(v,err) r.verdict=v; if err then r.error=tostring(err) end wc.publish_probe(json.dump_string(r)) end
local ok,e=pcall(function()
 local q=sdk.get_managed_singleton("snow.QuestManager")
 local em=sdk.get_managed_singleton("snow.enemy.EnemyManager")
 local nq=q:get_field("_normalQuestData")
 local enemy=nq and nq:get_field("_EnemySetDataList")
 -- NormalQuestData path may differ; try direct condition dump off quest data
 local function arrDump(obj, field)
  if not obj then return nil end
  local a=obj:get_field(field)
  if not a then return nil end
  local okc,size=pcall(function() return a:call("get_Count") end)
  if okc and size then
   local t={}
   for i=0,math.min(size,7)-1 do
    local okv,v=pcall(function() return a:call("Get",i) end)
    t[i+1]=okv and v or "?"
   end
   return t
  end
  local ok2,el=pcall(function() return a:get_elements() end)
  if ok2 and type(el)=="table" then
   local t={}
   for i=1,math.min(#el,7) do t[i]=el[i] end
   return t
  end
  return "unreadable"
 end
 r.cond_normal=arrDump(nq, "_BossSetCondition")
 local param0=normal and nil or nil
 local si=em:call("getEnemySetInfo(System.Int32)",0)
 if si then
  local p=si:call("get_EnemySetParam")
  r.sourceParam={
    route=p:get_field("_RouteNo"), initSet=p:get_field("_InitSetName"),
    typeV=p:get_field("_TypeValue"), block=p:get_field("_BlockNo"),
    individual=p:get_field("_IndividualType"), sub=p:get_field("_SubType"),
  }
  r.sourcePos=(function() local sp=p:get_field("_SetPos"); return sp and {x=math.floor(sp.x*10)/10,y=math.floor(sp.y*10)/10,z=math.floor(sp.z*10)/10} end)()
 end
 local nqdata=q:get_field("_ActiveQuestData")
 r.activeQuest=nqdata and tostring(nqdata:get_type_definition():get_full_name()) or nil
 r.cond_active=arrDump(nqdata, "_BossSetCondition")
 publish("PASS")
end)
if not ok then publish("ERROR",e) end
