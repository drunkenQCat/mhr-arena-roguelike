-- Kill a specific boss UID (cleanup helper).
local wc=require("webconsole")
local r={kind="run_script",script="probe_kill_uid.lua",epoch=wc.epoch(),session=wc.session_id(),verdict="FAIL"}
local function publish(v,err) r.verdict=v; if err then r.error=tostring(err) end wc.publish_probe(json.dump_string(r)) end
local TARGETUID=10600
local frames,state=0,0
-- EnemyCharacterBase.update hooks do not fire for elders (derived classes may not
-- call the base impl); EnemyManager.update runs every frame regardless.
sdk.hook(sdk.find_type_definition("snow.enemy.EnemyManager"):get_method("update"),function()
 if state~=1 then return end
 pcall(function()
  local em=sdk.get_managed_singleton("snow.enemy.EnemyManager")
  local n=em:call("getBossEnemyCount")
  for i=0,n-1 do
   local e=em:call("getBossEnemy",i)
   if e and e:call("get_UniqueId")==TARGETUID and not e:call("isDieBehaviorActive") then
    e:call("stockDirectForceKillDamage")
   end
  end
 end)
end)
re.on_frame(function()
 frames=frames+1
 if frames<10 then return end
 local em=sdk.get_managed_singleton("snow.enemy.EnemyManager")
 local n=em:call("getBossEnemyCount")
 local alive=false
 for i=0,n-1 do
  local e=em:call("getBossEnemy",i)
  if e and e:call("get_UniqueId")==TARGETUID and not e:call("isDieBehaviorActive") then alive=true end
 end
 if not alive then r.uid=TARGETUID; r.frames=frames; publish("PASS"); return end
 if frames>3000 then publish("FAIL","still alive") end
end)
