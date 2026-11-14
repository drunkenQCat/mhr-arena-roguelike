return {
  definition = {
    id = "item.grant", version = "1", name = "道具发放（立即交付）",
    description = "向购买者道具袋发放指定数量，按袋内数量增量核验。",
    delivery = "instant", verification = "attribute", experimental = false,
    recoveryScope = "inventory",
    supportedPhases = {"Preparing", "Selecting", "Carve"},
    group = "item.grant", quantityParameter = "count",
    parameters = {
      itemId = { name = "游戏道具 ID", description = "从道具目录选择，不能使用装备 ID", unit = "ID", min = 1, max = 4294967295, default = 68157446, integer = true },
      count = { name = "发放数量", description = "确认全部交付才结算；部分交付保留待办", unit = "件", min = 1, max = 99, default = 1, integer = true }
    }
  },
  check = function(api, p) return api.check_item(p.itemId, p.count) end,
  apply = function(api, p) return api.grant_item(p.itemId, p.count) end,
  inspect = function(api, p, receipt) return api.inspect_item(receipt) end,
  remove = function(api, p, receipt) return {status="applied", verification="attribute", message="立即交付物资由本局背包隔离器统一回收"} end
}
