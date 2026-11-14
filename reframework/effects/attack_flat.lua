-- Field-level verification, NOT a claim that each hit deals 10 extra damage.
return {
  definition = {
    id = "attack.flat", version = "1", name = "下一波攻击加成（固定值）",
    description = "增加购买者的运行时攻击加成字段；实际伤害仍由武器动作与怪物肉质计算。",
    delivery = "nextWave", verification = "attribute", experimental = false,
    rebindOnNativeReset = true,
    recoveryScope = "runtimeAttribute",
    supportedPhases = {"Preparing", "Selecting"},
    group = "attack.flat", quantityParameter = "amount",
    parameters = { amount = { name = "攻击加成", description = "固定点数，不是百分比或最终伤害", unit = "点", min = 1, max = 100, default = 10, integer = true } }
  },
  check = function(api, parameters) return api.check_stat("_AtkUpAlive", parameters.amount) end,
  apply = function(api, parameters) return api.add_stat("_AtkUpAlive", parameters.amount) end,
  inspect = function(api, parameters, receipt) return api.inspect_stat(receipt) end,
  rebind = function(api, parameters, receipt) return api.rebind_stat(receipt, parameters.amount) end,
  remove = function(api, parameters, receipt) return api.restore_stat(receipt) end
}
