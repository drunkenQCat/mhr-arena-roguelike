-- Force quest fail via setQuestFail and poll isPlayQuest.
local wc=require("webconsole")
local r={kind="run_script",script="probe_finish_fail.lua",epoch=wc.epoch(),session=wc.session_id(),verdict="FAIL"}
local function publish(v,err) r.verdict=v; if err then r.error=tostring(err) end wc.publish_probe(json.dump_string(r)) end
local frames,state=0,0
local q0=sdk.get_managed_singleton("snow.QuestManager")
local ok,e=pcall(function()
 assert(q0:call("get_ActiveQuestNo")==900102,"not our quest")
 local reason=0
 local frtd=sdk.find_type_definition("snow.quest.FailReason")
 if frtd then
  for _,f in ipairs(frtd:get_fields()) do
   if f:get_name()=="Normal" then
    local okv,v=pcall(f.get_data,f,nil)
    if okv and type(v)=="number" then reason=v end
   end
  end
 end
 local okc,c=pcall(function() return q0:call("setQuestFail",reason) end)
 r.failCall={ok=okc,err=okc and nil or tostring(c)}
end)
if not ok then publish("ERROR",e);state=99 end
re.on_frame(function()
 if state==99 then return end
 frames=frames+1
 local q=sdk.get_managed_singleton("snow.QuestManager")
 if not q:call("isPlayQuest") then
  r.frames=frames
  publish("PASS");state=99
 elseif frames>1200 then
  publish("FAIL","still playing after 1200 frames")
 end
end)
