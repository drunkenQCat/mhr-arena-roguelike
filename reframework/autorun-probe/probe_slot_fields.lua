-- Dump QuestManager._BossSet slot fields.
local wc=require("webconsole")
local r={kind="run_script",script="probe_slot_fields.lua",epoch=wc.epoch(),session=wc.session_id(),verdict="FAIL"}
local function publish(v,err) r.verdict=v; if err then r.error=tostring(err) end wc.publish_probe(json.dump_string(r)) end
local ok,e=pcall(function()
 local q=sdk.get_managed_singleton("snow.QuestManager")
 local slots=q:get_field("_BossSet")
 local out={}
 for i=0,slots:get_size()-1 do
  local s=slots:get_element(i)
  local row={}
  for _,f in ipairs(s:get_type_definition():get_fields()) do
   local okv,v=pcall(function() return s:get_field(f:get_name()) end)
   if okv and type(v)=="number" then row[f:get_name()]=v end
  end
  out["slot"..i]=row
 end
 r.slots=out
 local cond=q:get_field("_BossSetCondition")
 if cond then
  local crows={}
  for i=0,math.min(cond:get_size() or 0,6)-1 do
   local c=cond:get_element(i)
   local row={}
   for _,f in ipairs(c:get_type_definition():get_fields()) do
    local okv,v=pcall(function() return c:get_field(f:get_name()) end)
    if okv and type(v)=="number" then row[f:get_name()]=v end
   end
   crows[i+1]=row
  end
  r.conditions=crows
 end
 publish("PASS")
end)
if not ok then publish("ERROR",e) end
