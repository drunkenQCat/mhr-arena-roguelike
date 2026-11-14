return {
  definition = {
    id = "equipment.roll", version = "1", name = "装备抽取（立即交付）",
    description = "使用本局抽装池真实抽取；预览不会调用抽取或推进随机序列。",
    delivery = "instant", verification = "attribute", experimental = false,
    recoveryScope = "inventory",
    supportedPhases = {"Preparing", "Selecting", "Carve"},
    group = "equipment.roll", quantityParameter = false,
    parameters = { pool = { name = "奖池档位", description = "对应本局已配置的 gacha_1 至 gacha_4", unit = "档", min = 1, max = 4, default = 1, integer = true } }
  },
  check = function(api, p) return api.check_gacha(p.pool) end,
  apply = function(api, p) return api.roll_gacha(p.pool) end,
  inspect = function(api, p, receipt) return api.inspect_gacha(receipt) end,
  remove = function(api, p, receipt) return {status="applied", verification="attribute", message="本局装备由已有实例所有权与原装恢复器统一回收"} end
}
