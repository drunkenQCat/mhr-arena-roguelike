return {
  definition = {
    id = "defense.flat", version = "1", name = "下一波防御加成（固定值）",
    description = "增加购买者运行时防御加成字段；清波后核验移除，猫车不消耗波次。",
    delivery = "nextWave", verification = "attribute", experimental = false,
    rebindOnNativeReset = true,
    recoveryScope = "runtimeAttribute",
    supportedPhases = {"Preparing", "Selecting"},
    group = "defense.flat", quantityParameter = "amount",
    parameters = { amount = { name = "防御加成", description = "固定防御加成，不是减伤百分比", unit = "点", min = 1, max = 100, default = 15, integer = true } }
  },
  check = function(api, parameters) return api.check_stat("_DefUpAlive", parameters.amount) end,
  apply = function(api, parameters) return api.add_stat("_DefUpAlive", parameters.amount) end,
  inspect = function(api, parameters, receipt) return api.inspect_stat(receipt) end,
  rebind = function(api, parameters, receipt) return api.rebind_stat(receipt, parameters.amount) end,
  remove = function(api, parameters, receipt) return api.restore_stat(receipt) end
}
