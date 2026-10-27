-- Controlled species/slot-reuse experiment. Solo custom quest only.
local path="rogue_inplace_species_experiment.json"
local ledger={events={}}
pcall(function() local old=json.load_file(path);if old and old.events then ledger=old end end)
local pending,killUid,lastUid,lastUnique,message=nil,nil,nil,nil,"Arzuros (60), fresh parameter object."
local function record(event,detail)
    ledger.events[#ledger.events+1]={event=event,at=os.time(),detail=detail}
    json.dump_file(path,ledger,2)
end
local function scope()
    local q=sdk.get_managed_singleton("snow.QuestManager")
    local stage=sdk.get_managed_singleton("snow.stage.StageManager")
    if q and stage and not stage:call("get_IsQuestOnline") and q:call("isPlayQuest") and q:call("get_ActiveQuestNo")==900102 then return q end
end
local function append(reuse)
    local q=assert(scope(),"Playing solo M2a required")
    assert(q:get_field("_ExtraEmRno")==10,"Native scheduler not at End")
    local unique=q:call("getActiveQuestUniqueNo")
    local index=q:get_field("_BossSetCount")
    local order=q:get_field("_BossSetNoTbl")
    assert(index>=2 and index<order:get_size()-1,"No free order entry left")
    assert(order:call("Get",index)==-1 and order:call("Get",index+1)==-1,"Order tail is not empty")
    for _,e in ipairs(ledger.events) do
        assert(not(e.event=="before" and e.detail.unique==unique and e.detail.orderIndex==index),"Already attempted this order entry")
    end
    local em=sdk.get_managed_singleton("snow.enemy.EnemyManager")
    assert(em:call("getBossEnemyCount")==1,"Keep only the original second boss alive")
    local anchor=em:call("getBossEnemy",0)
    assert(anchor:call("get_UniqueId")==100 and anchor:call("get_EnemyType")==54 and not anchor:call("isDieBehaviorActive"),"Original Baggi must remain alive")
    local original=em:call("getEnemySetInfo(System.Int32)",0)
    assert(original and original:call("get_SetStatus")==4 and not original:call("get_OwnerEnemy"),"First monster not cleared")
    local source=original:call("get_EnemySetParam")
    assert(source:get_field("_TypeValue")==98,"Original parameter changed")
    local slots=q:get_field("_BossSet")
    local slotNo
    if reuse then
        local s=slots:get_element(2)
        assert(s:get_field("State")==2 and s:get_field("EmSetId")==-1,"Task slot 2 must be released")
        slotNo=2
    else
        for i=0,slots:get_size()-1 do
            local s=slots:get_element(i)
            if s:get_field("State")==0 and s:get_field("EmSetId")==-1 then slotNo=i;break end
        end
        assert(slotNo,"No unused task slot")
    end
    -- Fresh managed parameters: never change the old monster's parameter object.
    local param=assert(sdk.create_instance("snow.quest.BossSetParam",true),"Cannot allocate BossSetParam")
    param:add_ref()
    local ok,err=pcall(function()
        param:call(".ctor()")
        for _,name in ipairs({"HideGroup","_SetPos","_SetRot","_SubType","_BlockNo","_IndividualType","_RouteNo"}) do
            param:set_field(name,source:get_field(name))
        end
        param:set_field("_TypeValue",60)
        assert(source:get_field("_TypeValue")==98 and param:get_field("_TypeValue")==60,"Parameter isolation failed")
        local before=em:get_field("_EnemySetInfoList"):call("get_Count")
        record("before",{unique=unique,orderIndex=index,taskSlot=slotNo,reused=reuse,type=60,sourceType=98,count=before})
        local fresh=assert(em:call("createEnemySetInfo(snow.quest.EnemySetParam)",param),"Native registration returned nil")
        local id=fresh:call("get_EmSetId")
        local uid=fresh:call("get_UniqueId")
        assert(id>=before and uid~=100 and fresh:call("get_SetStatus")==0,"Fresh identity invalid")
        lastUid=uid;lastUnique=unique
        record("registered",{unique=unique,id=id,uid=uid,type=60,orderIndex=index,taskSlot=slotNo})
        local slot=slots:get_element(slotNo)
        slot:set_field("EmSetId",id);slot:set_field("EmType",60);slot:set_field("State",0)
        q:get_field("_BossLoadStartOk"):call("Set",slotNo,false)
        q:get_field("_BossLoadDone"):call("Set",slotNo,0)
        order:call("Set",index,slotNo)
        q:set_field("_ExtraEmRno",5)
        record("requested-native-load",{unique=unique,uid=uid,type=60,phase=5,orderIndex=index,taskSlot=slotNo})
        message="Native Arzuros load requested; UID "..uid.." / task slot "..slotNo
    end)
    param:release()
    if not ok then error(err) end
end
sdk.hook(sdk.find_type_definition("snow.enemy.EnemyCharacterBase"):get_method("update"),function(args)
    if not killUid then return end
    local q=scope()
    if not q or q:call("getActiveQuestUniqueNo")~=lastUnique then killUid=nil;return end
    local ok,err=pcall(function()
        local e=sdk.to_managed_object(args[2])
        if e:call("get_UniqueId")==killUid and e:call("get_EnemyType")==60 and not e:call("isDieBehaviorActive") then
            e:call("stockDirectForceKillDamage")
            record("targeted-kill-request",{unique=lastUnique,uid=killUid,type=60})
            killUid=nil
        end
    end)
    if not ok then message=tostring(err);killUid=nil;record("error",message) end
end)
re.on_frame(function()
    if pending then
        local reuse=pending=="reuse";pending=nil
        local ok,err=pcall(append,reuse)
        if not ok then message=tostring(err);record("error",message) end
    end
end)
re.on_draw_ui(function()
    if imgui.tree_node("inPlace DIFFERENT SPECIES: Arzuros") then
        imgui.text(message)
        if imgui.button("Append Arzuros in UNUSED task slot") then pending="new" end
        if imgui.button("Append Arzuros reusing RELEASED task slot 2") then pending="reuse" end
        if imgui.button("Kill ONLY last experimental Arzuros") then
            if lastUid then killUid=lastUid else message="No Arzuros registered in this script session" end
        end
        imgui.tree_pop()
    end
end)
