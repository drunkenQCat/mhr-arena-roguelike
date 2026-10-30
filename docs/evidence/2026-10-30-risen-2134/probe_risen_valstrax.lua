-- Risen Crimson Glow Valstrax (2134) arena-compatibility probe, five steps:
-- mount -> native load -> size/fence readings -> directed kill -> death event.
-- Mounts into an unused task slot of the live solo M2 quest (type-agnostic
-- createEnemySetInfo path proven by inplace_species_probe 2026-10-27).
-- Run: node cli/mhr.mjs game run-script reframework/autorun-probe/probe_risen_valstrax.lua --timeout 90 --json
local wc=require("webconsole")
local r={kind="run_script",script="probe_risen_valstrax.lua",epoch=wc.epoch(),session=wc.session_id(),verdict="FAIL",steps={}}
local function publish(v,err) r.verdict=v; if err then r.error=tostring(err) end wc.publish_probe(json.dump_string(r)) end
local TARGET=2134
local frames,state=0,0
local deadline={load=nil,death=nil,release=nil}
local uid,slotNo,emSetId,orderIndex,unique
local killRequested=false
local edm=sdk.get_managed_singleton("snow.enemy.EnemyManager")
local function scope()
 local q=sdk.get_managed_singleton("snow.QuestManager")
 local stage=sdk.get_managed_singleton("snow.stage.StageManager")
 if q and stage and not stage:call("get_IsQuestOnline") and q:call("isPlayQuest") and q:call("get_ActiveQuestNo")==900102 then return q end
 return nil
end
local function step(name,detail,ok)
 r.steps[#r.steps+1]={step=name,frame=frames,ok=ok==nil and true or ok,detail=detail}
 return ok==nil and true or ok
end
local function readBoss(e)
 local out={uid=e:call("get_UniqueId"),etype=e:call("get_EnemyType")}
 local pos=nil
 for _,cn in ipairs({"get_Position","get_Pos","get_PositionW"}) do
  local okp,p=pcall(function() return e:call(cn) end)
  if okp and p and p.x then pos=p break end
 end
 if not pos then
  for _,fn in ipairs({"_Position","_Pos"}) do
   local okp,p=pcall(function() return e:get_field(fn) end)
   if okp and p and p.x then pos=p break end
  end
 end
 if pos then out.pos={x=math.floor((pos.x or 0)*100)/100,y=math.floor((pos.y or 0)*100)/100,z=math.floor((pos.z or 0)*100)/100} end
 for _,m in ipairs({{"Total","get_TotalScale"},{"Base","get_BaseScale"},{"Quest","get_QuestDesignationScale"}}) do
  local okv,v=pcall(function() return e:call(m[2]) end)
  if okv and type(v)=="number" then out["scale_"..m[1]]=math.floor(v*1000)/1000 end
 end
 local okh,hp=pcall(function() return e:call("getHpVital") end)
 local okm,mx=pcall(function() return e:call("getHpMaxVital") end)
 if okh and type(hp)=="number" then out.hp=math.floor(hp) end
 if okm and type(mx)=="number" then out.hpMax=math.floor(mx) end
 return out
end
-- step 4 hook: directed kill via EnemyManager.update (runs every frame for all
-- bosses; EnemyCharacterBase.update hooks do NOT fire for elders — derived
-- classes may skip the base impl, verified live 2026-10-30 on 2134).
sdk.hook(sdk.find_type_definition("snow.enemy.EnemyManager"):get_method("update"),function()
 if not killRequested or state==4 then return end
 pcall(function()
  local em=sdk.get_managed_singleton("snow.enemy.EnemyManager")
  local n=em:call("getBossEnemyCount")
  for i=0,n-1 do
   local e=em:call("getBossEnemy",i)
   if e and e:call("get_UniqueId")==uid and e:call("get_EnemyType")==TARGET and not e:call("isDieBehaviorActive") then
    e:call("stockDirectForceKillDamage")
    if not killRequested or state==3 then
     killRequested=false
     step("kill-stocking",{uid=uid,frame=frames,note="stock damage queued; elder death flow takes ~40-60s"})
    end
    break
   end
  end
 end)
end)
re.on_frame(function()
 if state==99 then return end
 frames=frames+1
 if frames>8400 then publish("FAIL","global timeout");state=99;return end
 local q=scope()
 if not q then if frames>600 then publish("FAIL","quest scope lost");state=99 end return end
 if state==0 then
  -- step 1: mount into unused slot
  if q:get_field("_ExtraEmRno")~=10 then if frames>900 then publish("FAIL","scheduler not at End (_ExtraEmRno~=10)") state=99 end return end
  local ok,err=pcall(function()
   local em=edm
   unique=q:call("getActiveQuestUniqueNo")
   assert(em:call("getBossEnemyCount")>=1,"no anchor boss alive")
   local index=q:get_field("_BossSetCount")
   local order=q:get_field("_BossSetNoTbl")
   assert(order:call("Get",index)==-1 and order:call("Get",index+1)==-1,"order tail not empty")
   local slots=q:get_field("_BossSet")
   -- slot 1 = EM1_HP condition (proven in-bounds, full HP); slot 2+ = HP_EMx1
   -- which spawns at a dead EM's position (out of bounds + split HP when alive).
   local s=slots:get_element(1)
   if (s:get_field("State")==0 or s:get_field("State")==2) and s:get_field("EmSetId")==-1 then
    slotNo=1
   else
    for i=2,slots:get_size()-1 do
     local s2=slots:get_element(i)
     if s2:get_field("State")==0 and s2:get_field("EmSetId")==-1 then slotNo=i break end
    end
   end
   assert(slotNo,"slot 1 unavailable and no fallback")
   local original=em:call("getEnemySetInfo(System.Int32)",0)
   assert(original,"no source setinfo")
   local source=original:call("get_EnemySetParam")
   local param=assert(sdk.create_instance("snow.quest.BossSetParam",true),"cannot allocate BossSetParam")
   param:add_ref()
   local okI,errI=pcall(function()
    param:call(".ctor()")
    for _,name in ipairs({"HideGroup","_SetPos","_SetRot","_SubType","_BlockNo","_IndividualType","_RouteNo"}) do
     param:set_field(name,source:get_field(name))
    end
    param:set_field("_TypeValue",TARGET)
    local before=em:get_field("_EnemySetInfoList"):call("get_Count")
    local fresh=assert(em:call("createEnemySetInfo(snow.quest.EnemySetParam)",param),"registration returned nil")
    emSetId=fresh:call("get_EmSetId"); uid=fresh:call("get_UniqueId")
    assert(fresh:call("get_SetStatus")==0,"fresh identity invalid")
    local slot=slots:get_element(slotNo)
    slot:set_field("EmSetId",emSetId);slot:set_field("EmType",TARGET);slot:set_field("State",0)
    q:get_field("_BossLoadStartOk"):call("Set",slotNo,false)
    q:get_field("_BossLoadDone"):call("Set",slotNo,0)
    order:call("Set",index,slotNo)
    q:set_field("_ExtraEmRno",5)
    orderIndex=index
    step("mounted",{emSetId=emSetId,uid=uid,taskSlot=slotNo,orderIndex=index,type=TARGET,sourceType=source:get_field("_TypeValue"),listCount=before+1})
   end)
   param:release()
   if not okI then error(errI) end
  end)
  if not ok then publish("FAIL","mount: "..tostring(err));state=99;return end
  state=1;deadline.load=frames+1500
 elseif state==1 then
  -- step 2: native load poll
  local ok,err=pcall(function()
   local slots=q:get_field("_BossSet")
   local s=slots:get_element(slotNo)
   if s:get_field("State")==1 and s:get_field("EmSetId")==emSetId then
    local found=nil
    local n=edm:call("getBossEnemyCount")
    for i=0,n-1 do
     local e=edm:call("getBossEnemy",i)
     if e and e:call("get_UniqueId")==uid and e:call("get_EnemyType")==TARGET then found=e break end
    end
    if found then
     local d=readBoss(found)
     step("native-loaded",{frames=frames,slotState=1,bossCount=n,boss=d})
     state=2
     killRequested=true
     deadline.death=frames+3300
    end
   end
  end)
  if not ok then publish("FAIL","load-poll: "..tostring(err));state=99;return end
  if state==1 and frames>deadline.load then publish("FAIL","native load timeout");state=99 end
 elseif state==2 then
  -- step 3: poll until the elder settles inside the arena (born mid-air, it
  -- descends for several seconds — readings at 90 frames falsely failed).
  if frames%60==0 then
   local ok,err=pcall(function()
    local found=nil
    local n=edm:call("getBossEnemyCount")
    for i=0,n-1 do
     local e=edm:call("getBossEnemy",i)
     if e and e:call("get_UniqueId")==uid then found=e break end
    end
    assert(found,"boss vanished after load")
    local d=readBoss(found)
    local inBounds=d.pos and math.abs(d.pos.x)<150 and math.abs(d.pos.z)<150 and d.pos.y>-20
    step("settle-poll",{frames=frames,inBounds=inBounds,pos=d.pos})
    if inBounds and state==2 then
     step("readings",{frames=frames,boss=d,inBounds=true,
       fence={xBound=150,zBound=150,note="settled inside arena map-10 bounds"}})
     state=3
    end
   end)
   if not ok then publish("FAIL","readings: "..tostring(err));state=99 end
  end
 elseif state==2 or state==3 or state==4 then
  -- steps 4/5: wait death then slot release
  local ok,err=pcall(function()
   local found=nil
   local n=edm:call("getBossEnemyCount")
   for i=0,n-1 do
    local e=edm:call("getBossEnemy",i)
    if e and e:call("get_UniqueId")==uid and e:call("get_EnemyType")==TARGET then found=e break end
   end
   if state~=4 then
    if (not found) or found:call("isDieBehaviorActive") then
     local d=found and readBoss(found) or {erased=true}
     if state==2 then
      local inB=d.pos and math.abs(d.pos.x)<150 and math.abs(d.pos.z)<150 and d.pos.y>-20
      step("readings",{frames=frames,boss=d,inBounds=inB,fence={note="read at death"}})
     end
     step("death-event",{frames=frames,die=d})
     state=4
     deadline.release=frames+1200
    elseif frames>deadline.death then
     error("directed kill timeout (elder death flow > window)")
    end
   else
    local slots=q:get_field("_BossSet")
    local s=slots:get_element(slotNo)
    if s:get_field("State")==2 and s:get_field("EmSetId")==-1 then
     step("slot-released",{frames=frames,taskSlot=slotNo})
     publish("PASS")
     state=99
    elseif frames>deadline.release then
     step("slot-released",{frames=frames,released=false,note="corpse cleanup slower than window; death already evidenced"})
     publish("PASS")
     state=99
    end
   end
  end)
  if not ok then publish("FAIL","death/release: "..tostring(err));state=99 end
 end
end)
