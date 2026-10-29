-- Manual, read-only investigation probe. Not deployed by the normal build.
-- Live snapshots stop after 60 seconds; transition history is bounded.
local names={"snow.gui.GuiManager","snow.gui.GuiCommonDialogWindow","snow.gui.GuiCommonDialogWindow.DialogInfo","snow.gui.GuiSaveDataSelectMenu","snow.gui.fsm.title.GuiTitle","snow.gui.fsm.title.GuiTitleMenu","snow.gui.fsm.title.GuiTitleFsmManager","snow.gui.fsm.title.GuiTitleMenuFsmManager","snow.gui.GuiSaveDataMgr","snow.SaveService","snow.SceneManager","snow.gui.StmGuiInput","snow.gui.GuiInput","snow.gui.GuiCommonInfoBase","snow.gui.SnowGuiCommonUtility.BoxMenuCursor","snow.StmInputManager","snow.StmUIInputData","snow.gui.SnowGuiCommonUtility","snow.gui.SnowGuiCommonUtility.MouseBasisCtrl","snow.gui.SnowGuiCommonUtility.MouseCtrlBase","snow.gui.fsm.title.GuiTitleFsm_TitleMenu_Action","snow.gui.fsm.title.GuiTitleFsm_LoadDataSelectMenuStart","snow.gui.GuiNetworkErrorWindow","snow.gui.GuiCommonYNInfoWindow","snow.gui.SnowGuiCommonUtility.MenuListCursor","snow.gui.SnowGuiCommonUtility.YNCursor","snow.LoadInfoSingleData","snow.gui.fsm.title.GuiTitleFsm_PressAnyButton_Action"}
local out={types={},singletons={}}
for _,n in ipairs(names) do
 local td=sdk.find_type_definition(n)
 if td then
  local t={fields={},methods={}} out.types[n]=t
  local cursor=td
  for level=1,4 do
   if not cursor then break end
   for _,f in ipairs(cursor:get_fields()) do t.fields[#t.fields+1]={name=f:get_name(),type=f:get_type():get_full_name(),static=f:is_static()} end
   for _,m in ipairs(cursor:get_methods()) do local ps={} for _,p in ipairs(m:get_param_types() or {}) do ps[#ps+1]=p:get_full_name() end t.methods[#t.methods+1]={name=m:get_name(),params=ps,ret=m:get_return_type():get_full_name(),address=tostring(m:get_function())} end
   cursor=cursor:get_parent_type()
  end
  local ok,o=pcall(sdk.get_managed_singleton,n)
  if ok and o then local s={} out.singletons[n]=s for _,f in ipairs(td:get_fields()) do local ok,v=pcall(function() return f:get_data(o) end) s[f:get_name()]=ok and tostring(v) or 'ERROR' end end
 end
end
json.dump_file('rogue_ui_metadata.json',out,2)

local function dump(o,depth)
 if o==nil then return nil end
 if type(o)~="userdata" then return o end
 local ok,td=pcall(function() return o:get_type_definition() end)
 if not ok or not td then return tostring(o) end
 local r={type=td:get_full_name(),address=tostring(o)}
 if depth<=0 then return r end
 for _,f in ipairs(td:get_fields()) do
  if not f:is_static() then local n=f:get_name() local ok,v=pcall(function() return f:get_data(o) end)
   if ok then r[n]=type(v)=="userdata" and dump(v,depth-1) or v end
  end
 end
 return r
end
local lastAt=0
local stopAt=os.time()+60
re.on_frame(function()
 if os.time()>stopAt then return end
 if os.time()==lastAt then return end lastAt=os.time()
 local gm=sdk.get_managed_singleton("snow.gui.GuiManager")
 if not gm then return end
 local s={at=lastAt}
 for _,n in ipairs({"refGuiNetworkErrorWindow","refGuiCommonYNInfoWindow","refGuiCommonInfoWindow","refGuiSaveDataSelectMenu"}) do
  local ok,o=pcall(function()return gm:call("get_"..n)end)
  if ok and o then s[n]=dump(o,2) local ok,v=pcall(function()return o:call("isOpen")end) if ok then s[n].isOpen=v end local ok,v=pcall(function()return o:call("getText")end) if ok then s[n].text=v end end
 end
 for _,n in ipairs({"snow.gui.fsm.title.GuiTitleFsmManager","snow.gui.fsm.title.GuiTitleMenuFsmManager"}) do
  local o=sdk.get_managed_singleton(n) if o then s[n]=dump(o,2) local ok,v=pcall(function()return o:call("getCurrentNodeName",0)end) if ok then s[n].node=v end end
 end
 json.dump_file('rogue_ui_observation.json',s,2)
end)

local changes={}
for _,tn in ipairs({"snow.gui.fsm.title.GuiTitleFsmToLoadDataSelectMenu","snow.gui.fsm.title.GuiTitleFsm_LoadDataSelectMenuStart"}) do
 local td=sdk.find_type_definition(tn)
 if td then local m=td:get_method("start") if m then sdk.hook(m,function(args)
  local state={action=tn,at=os.time()}
  for _,n in ipairs({"snow.gui.fsm.title.GuiTitleFsmManager","snow.gui.fsm.title.GuiTitleMenuFsmManager"}) do
   local o=sdk.get_managed_singleton(n) if o then state[n]={branch=o:call("get_BaseBranchValue"),under=o:call("get_UnderLayerValue")} end
  end
  if #changes>=32 then table.remove(changes,1) end
  changes[#changes+1]=state json.dump_file('rogue_ui_transition_trace.json',changes,2)
 end) end end
end
