-- Diagnose kill methods on a boss uid: try several, report states.
local wc=require("webconsole")
local r={kind="run_script",script="probe_kill_diag.lua",epoch=wc.epoch(),session=wc.session_id(),verdict="FAIL"}
local function publish(v,err) r.verdict=v; if err then r.error=tostring(err) end wc.publish_probe(json.dump_string(r)) end
local ok,e=pcall(function()
 local em=sdk.get_managed_singleton("snow.enemy.EnemyManager")
 local n=em:call("getBossEnemyCount")
 local target=nil
 for i=0,n-1 do
  local b=em:call("getBossEnemy",i)
  if b and b:call("get_UniqueId")==10600 then target=b break end
 end
 assert(target,"10600 not found among "..n.." bosses")
 r.type=tostring(target:get_type_definition():get_full_name())
 for _,m in ipairs({"isDieBehaviorActive","getHpVital","getHpMaxVital","stockDirectForceKillDamage","dieDirectErase","setExceptionalDie","requestShellDestroyAll"}) do
  local okm,mm=pcall(function() return target:get_type_definition():get_method(m) end)
  r["has_"..m]=okm and (mm~=nil) or tostring(mm)
 end
 local okh,hp=pcall(function() return target:call("getHpVital") end)
 r.hpBefore=okh and hp or tostring(hp)
 local ok1,e1=pcall(function() target:call("stockDirectForceKillDamage") end)
 r.tryForce={ok=ok1,err=ok1 and nil or tostring(e1)}
 local ok2,hp2=pcall(function() return target:call("getHpVital") end)
 r.hpAfterForce=ok2 and hp2 or tostring(hp2)
 publish("PASS")
end)
if not ok then publish("ERROR",e) end
