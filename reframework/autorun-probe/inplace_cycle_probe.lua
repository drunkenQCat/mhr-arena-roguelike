-- Lightweight solo arena experiment. No large snapshots or per-frame file writes.
local events,dirty,hold,kill,unique,pending,message={},false,false,false,nil,nil,"Hold clear before removing the last original target."
local last,nextAt=nil,0
local path="rogue_inplace_cycle.json"
local function qscope()
 local q=sdk.get_managed_singleton("snow.QuestManager")
 local stage=sdk.get_managed_singleton("snow.stage.StageManager")
 if q and stage and not stage:call("get_IsQuestOnline") and q:call("isPlayQuest") and q:call("get_ActiveQuestNo")==900102 then return q end
end
local function activeHold()
 local q=qscope();return hold and q and q:call("getActiveQuestUniqueNo")==unique
end
local function event(name,data)
 if #events>=200 then table.remove(events,1) end
 events[#events+1]={at=os.time(),event=name,detail=data};dirty=true
end
local function snapshot(q)
 local em=sdk.get_managed_singleton("snow.enemy.EnemyManager")
 local s={unique=q:call("getActiveQuestUniqueNo"),phase=q:get_field("_ExtraEmRno"),cursor=q:get_field("_BossSetCount"),status=q:get_field("_QuestStatus"),hold=hold,bosses={},slots={},order={}}
 for i=0,em:call("getBossEnemyCount")-1 do
  local e=em:call("getBossEnemy",i);s.bosses[#s.bosses+1]={uid=e:call("get_UniqueId"),type=e:call("get_EnemyType"),dying=e:call("isDieBehaviorActive")}
 end
 local slots=q:get_field("_BossSet")
 for i=0,slots:get_size()-1 do local v=slots:get_element(i);s.slots[#s.slots+1]={state=v:get_field("State"),id=v:get_field("EmSetId"),type=v:get_field("EmType")} end
 local order=q:get_field("_BossSetNoTbl")
 for i=0,order:get_size()-1 do s.order[#s.order+1]=order:call("Get",i) end
 return s
end
for _,name in ipairs({"setQuestClear","setQuestClearSub"}) do
 sdk.hook(sdk.find_type_definition("snow.QuestManager"):get_method(name),function()
  if activeHold() then return sdk.PreHookResult.SKIP_ORIGINAL end
  return sdk.PreHookResult.CALL_ORIGINAL
 end)
end
sdk.hook(sdk.find_type_definition("snow.QuestManager"):get_method("checkQuestClear"),function() end,function(ret)
 if activeHold() then return sdk.to_ptr(0) end;return ret
end)
sdk.hook(sdk.find_type_definition("snow.QuestManager"):get_method("questEnemyDie"),function(args)
 if activeHold() then
  local ok,err=pcall(function() local e=sdk.to_managed_object(args[3]);event("native-death",{uid=e:call("get_UniqueId"),type=e:call("get_EnemyType"),kind=sdk.to_int64(args[4])}) end)
  if not ok then event("death-error",tostring(err)) end
 end
end)
local killed={}
sdk.hook(sdk.find_type_definition("snow.enemy.EnemyCharacterBase"):get_method("update"),function(args)
 if not kill or not activeHold() then return end
 local ok,err=pcall(function()
  local e=sdk.to_managed_object(args[2]);local uid=e:call("get_UniqueId")
  if not killed[uid] and e:call("get_EnemyType")<256 and not e:call("isDieBehaviorActive") then
   local em=sdk.get_managed_singleton("snow.enemy.EnemyManager");local found=false
   for i=0,em:call("getBossEnemyCount")-1 do if em:call("getBossEnemy",i):call("get_UniqueId")==uid then found=true end end
   if found then e:call("stockDirectForceKillDamage");killed[uid]=true;event("kill-request",{uid=uid}) end
  end
 end)
 if not ok then kill=false;event("kill-error",tostring(err)) end
end)
local function spawn(q)
 assert(activeHold(),"Enable clear hold first")
 local em=sdk.get_managed_singleton("snow.enemy.EnemyManager")
 assert(em:call("getBossEnemyCount")==0,"Wait for all corpses to clear")
 assert(q:get_field("_ExtraEmRno")==10,"Scheduler not at End")
 local slots=q:get_field("_BossSet")
 for i=0,slots:get_size()-1 do assert(slots:get_element(i):get_field("EmSetId")==-1,"Task slot still assigned") end
 local source=em:call("getEnemySetInfo(System.Int32)",0):call("get_EnemySetParam")
 local param=assert(sdk.create_instance("snow.quest.BossSetParam",true));param:add_ref()
 local ok,err=pcall(function()
  param:call(".ctor()")
  for _,n in ipairs({"HideGroup","_SetPos","_SetRot","_SubType","_BlockNo","_IndividualType","_RouteNo"}) do param:set_field(n,source:get_field(n)) end
  param:set_field("_TypeValue",60)
  local count=em:get_field("_EnemySetInfoList"):call("get_Count")
  local fresh=assert(em:call("createEnemySetInfo(snow.quest.EnemySetParam)",param));local id=fresh:call("get_EmSetId")
  assert(id>=count,"Record was not appended")
  local slot=slots:get_element(2);slot:set_field("EmSetId",id);slot:set_field("EmType",60);slot:set_field("State",0)
  q:get_field("_BossLoadStartOk"):call("Set",2,false);q:get_field("_BossLoadDone"):call("Set",2,0)
  local order=q:get_field("_BossSetNoTbl")
  for i=2,order:get_size()-1 do order:call("Set",i,-1) end
  order:call("Set",2,2);q:set_field("_BossSetCount",2);q:set_field("_ExtraEmRno",5)
  kill=false;killed={};event("rewind-load",{uid=fresh:call("get_UniqueId"),type=60,record=id,cursor=2,slot=2,countBefore=count})
  message="Fresh Arzuros requested after all-clear; cursor rewound to 2"
 end)
 param:release();if not ok then error(err) end
end
re.on_frame(function()
 if pending then
  local action=pending;pending=nil
  local ok,err=pcall(function()
   local q=assert(qscope(),"Solo M2a must be playing")
   if action=="hold" then unique=q:call("getActiveQuestUniqueNo");hold=true;event("hold-enabled",snapshot(q));message="Clear HOLD enabled"
   elseif action=="kill" then assert(activeHold(),"Hold not enabled");kill=true;killed={};event("kill-armed",snapshot(q))
   elseif action=="spawn" then spawn(q)
   elseif action=="save" then event("manual",snapshot(q)) end
  end)
  if not ok then message=tostring(err);event("error",message) end
 end
 if os.time()>=nextAt then
  nextAt=os.time()+1
  local ok,err=pcall(function()
   local q=qscope();if not q then return end
   local s=snapshot(q);local key=json.dump_string(s)
   if key~=last then last=key;event("state",s) end
   if kill and #s.bosses==0 then kill=false end
  end)
  if not ok and tostring(err)~=message then message=tostring(err);event("poll-error",message) end
  if dirty then json.dump_file(path,{events=events},2);dirty=false end
 end
end)
re.on_draw_ui(function()
 if imgui.tree_node("inPlace LIGHT: all-clear and cursor loop") then
  imgui.text(message)
  if imgui.button("1 Enable clear HOLD") then pending="hold" end
  if imgui.button("2 Kill current bosses (HOLD required)") then pending="kill" end
  if imgui.button("3 After cleanup: spawn Arzuros / rewind cursor") then pending="spawn" end
  if imgui.button("Save small state") then pending="save" end
  imgui.tree_pop()
 end
end)
