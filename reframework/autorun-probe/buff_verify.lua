-- Bounded read-only stat sampling; invoke explicitly over the CLI.
local wc=require("webconsole")
local r={kind="run_script",script="buff_verify.lua",epoch=wc.epoch(),session=wc.session_id(),verdict="PASS",samples={}}
local frame=0
re.on_frame(function()
 if frame>=90 then return end
 frame=frame+1
 if frame%15~=0 then return end
 local ok,err=pcall(function()
  local pm=sdk.get_managed_singleton("snow.player.PlayerManager")
  local pl=pm and pm:call("findMasterPlayer")
  local pd=pl and pl:call("get_PlayerData")
  assert(pd,"PlayerData unavailable")
  local row={frame=frame}
  for _,n in ipairs({"_AtkUpAlive","_DefUpAlive","_CriticalRate","_Attack","_Defence"}) do row[n]=pd:get_field(n) end
  row.totalAttack=pl:call("calcTotalAttack")
  r.samples[#r.samples+1]=row
 end)
 if not ok then r.verdict="ERROR";r.error=tostring(err);frame=90 end
 if frame>=90 then wc.publish_probe(json.dump_string(r)) end
end)
