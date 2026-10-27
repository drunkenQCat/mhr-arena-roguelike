-- Read-only reflection export. No hooks, gameplay calls, or field writes.
local result={at=os.time(),types={}}
for _,name in ipairs({"snow.QuestManager","snow.enemy.EnemyManager","snow.enemy.EnemySetInfo","snow.quest.BossSetParam","snow.quest.EnemySetParam",
    "snow.data.EquipBox","snow.data.DataManager","snow.data.PlEquipInventoryData","snow.data.EquipInventoryData","snow.data.WeaponData","snow.data.EquipDataManager","snow.data.ContentsIdSystem.WeaponId"}) do
    local td=sdk.find_type_definition(name)
    if td then
        local out={fields={},methods={}}
        result.types[name]=out
        for _,f in ipairs(td:get_fields()) do
            out.fields[#out.fields+1]={name=f:get_name(),offset=f:get_offset_from_base(),type=f:get_type():get_full_name(),static=f:is_static()}
        end
        for _,m in ipairs(td:get_methods()) do
            local params={}
            for _,t in ipairs(m:get_param_types() or {}) do params[#params+1]=t:get_full_name() end
            out.methods[#out.methods+1]={name=m:get_name(),params=params,address=tostring(m:get_function())}
        end
    end
end
json.dump_file("rogue_inplace_native_metadata.json",result,2)
log.info("[inPlace] read-only native metadata exported")
