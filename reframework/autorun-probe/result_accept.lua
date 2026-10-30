-- Explicit CLI research helper: accept the owned solo arena result screen.
-- Run with: node cli/mhr.mjs game run-script reframework/autorun-probe/result_accept.lua --timeout 50 --json
-- No OS input, FSM jumps, save callbacks, inventory writes or global confirmation override.
-- Input pulses apply only inside the native Reward/Payoffselect actions, at most
-- once per 12 rendered frames. Sell-all selection is never confirmed.
-- Hooks become pass-through when finished; Reset scripts removes them completely.
-- One final report through publish_probe; no periodic file writes.
local wc=require("webconsole")
local r={kind="run_script",script="result_accept.lua",epoch=wc.epoch(),session=wc.session_id(),verdict="FAIL",transitions={},pulses=0,methods={}}
local active=true;local context=nil;local frame=0;local lastPulse=-100;local lastNode=nil
local function publish(verdict,err)
 if not active then return end
 active=false;r.verdict=verdict;r.error=err;r.frames=frame;wc.publish_probe(json.dump_string(r))
end
local ok,e=pcall(function()
 local qm=sdk.get_managed_singleton("snow.QuestManager");local gm=sdk.get_managed_singleton("snow.gui.GuiManager")
 local st=sdk.get_managed_singleton("snow.stage.StageManager")
 assert(not st:call("get_IsQuestOnline"),"offline only")
 assert(qm:call("get_ActiveQuestNo")==900102 and not qm:call("isPlayQuest"),"custom quest results only")
 local function boxCounts()
  local box=sdk.get_managed_singleton("snow.data.DataManager"):call("getItemBox")
  local list=box:get_field("_InventoryList");local counts={};local count=list:call("get_Count")
  assert(count>=0 and count<=10000,"unexpected item box size")
  for i=0,count-1 do
   local item=list:call("get_Item",i);local n=item:call("get_Count")
   if n>0 then local id=tostring(item:call("get_ItemId"));counts[id]=(counts[id] or 0)+n end
  end
  return counts
 end
 local beforeBox
 local boxOk,boxValue=pcall(boxCounts);if boxOk then beforeBox=boxValue else r.inventoryEvidenceError=tostring(boxValue) end
 local unique=qm:call("getActiveQuestUniqueNo");r.unique=unique
 local td=sdk.find_type_definition("snow.gui.GuiQuestResultFsmManager");local fsm=td:get_method("get_Instance"):call(nil)
 assert(fsm,"native result UI is not ready; quest_ready may still be the return countdown")
 local node=tostring(fsm:call("getCurrentNodeName",0));assert(node=="Reward" or node=="Payoffselect","unsupported initial node "..node)
 local start=os.clock();r.before=node
 for _,entry in ipairs({{"snow.gui.fsm.GuiQuestResultFsmActionReword","Reward"},{"snow.gui.fsm.GuiQuestPayoffFsmActionSelect","Payoffselect"}}) do
  local method=sdk.find_type_definition(entry[1]):get_method("update");local name=entry[2]
  sdk.hook(method,function() if active then context=name end end,function(rv) context=nil;return rv end)
 end
 local function eligible()
  if not active or frame-lastPulse<12 or r.pulses>=100 or not context then return false end
  if qm:call("getActiveQuestUniqueNo")~=unique or st:call("get_IsQuestOnline") then return false end
  if context=="Reward" then
   if fsm:get_field("isShowGUI")~=true then return false end
   if fsm:get_field("SelectState")==1 and fsm:get_field("RecvButtonCursor")~=0 then return false end
  end
  return tostring(fsm:call("getCurrentNodeName",0))==context
 end
 for _,name in ipairs({"getDecideButtonTrg","getDecideMouseEventRep"}) do
  local method=sdk.find_type_definition("snow.gui.StmGuiInput"):get_method(name)
  sdk.hook(method,function() end,function(rv)
   if eligible() and (name=="getDecideButtonTrg" or context=="Reward") then
    lastPulse=frame;r.pulses=r.pulses+1;r.methods[name]=(r.methods[name] or 0)+1
    return sdk.to_ptr(1)
   end
   return rv
  end)
 end
 re.on_frame(function()
  if not active then return end
  local ok2,err=pcall(function()
   frame=frame+1
   if frame%6~=0 then return end
   -- Result objects can be torn down before village controls become ready.
   -- Check the destination first and never query the old FSM after identity clears.
   local n=lastNode
   if gm:call("IsCanInvokeQuestBoard") and not qm:call("isPlayQuest") then
    r.after="village"
    if beforeBox then
     local okBox,afterBox=pcall(boxCounts)
     if okBox then
      r.itemBoxDelta={}
      for id,count in pairs(afterBox) do local delta=count-(beforeBox[id] or 0);if delta~=0 then r.itemBoxDelta[id]=delta end end
      for id,count in pairs(beforeBox) do if not afterBox[id] then r.itemBoxDelta[id]=-count end end
     else r.inventoryEvidenceError=tostring(afterBox) end
    end
    publish("PASS");return
   end
   if qm:call("getActiveQuestUniqueNo")~=unique then
    if qm:call("isActiveQuest") or qm:call("isPlayQuest") then publish("FAIL","another quest became active");return end
    r.waitingVillage=true
   elseif not r.waitingVillage then
    local current=td:get_method("get_Instance"):call(nil)
    if current then
     n=tostring(current:call("getCurrentNodeName",0))
     if n~=lastNode then lastNode=n;r.transitions[#r.transitions+1]={frame=frame,node=n,select=current:get_field("SelectState"),cursor=current:get_field("RecvButtonCursor")} end
    elseif lastNode=="Save" or lastNode=="End" then r.waitingVillage=true end
   end
   if os.clock()-start>40 or frame>=2400 then r.after=n;publish("FAIL","no confirmed village within bounded window") end
  end)
  if not ok2 then publish("ERROR",tostring(err)) end
 end)
end)
if not ok then publish("ERROR",tostring(e)) end
