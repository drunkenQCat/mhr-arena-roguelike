-- Read-only bootstrap for the MHR Roguelike research project.
-- Uses a conservative Lua syntax subset; runtime version is logged below.

local game_name = "unknown"
local ok, detected_name = pcall(function()
    return reframework:get_game_name()
end)

if ok and type(detected_name) == "string" then
    game_name = detected_name
end

log.info("RogueProbe: script loaded; game=" .. game_name .. "; runtime=" .. _VERSION)

re.on_draw_ui(function()
    if imgui.tree_node("MHR Roguelike Research") then
        imgui.text("Read-only REFramework probe")
        imgui.text("Game: " .. game_name)
        imgui.text("No game state has been modified.")
        imgui.tree_pop()
    end
end)
