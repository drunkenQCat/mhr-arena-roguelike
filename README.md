# MHR Free Arena prototype

Quest 900101 appears under Village Quests > Free Exploration. The quest is registered by `reframework/autorun/free_arena.lua` as a tour on arena map 10 with no time limit. It uses the game's quest menu; there is no Generated UI button.

On 2026-10-22, the player entered the quest and reported a bear in the arena. This fails the intended empty-arena behavior. The current log only confirms registration and list insertion; `free_arena_check.lua` checks stored quest data before departure and cannot identify the active quest or runtime spawns. Its `monsters=0` report must not be treated as an in-quest verification. The cause of the bear remains unconfirmed.

The monster ID table in `.local/RiseQuestLoader/RiseQuestEditor/Assets/Monsters.json` defines `0` as None and `60` as Arzuros. Base tour 101 has zero boss slots; the Lua installer changes its map to 10 and its small-monster set to 0. The quest type may have separate runtime spawning behavior, but that has not been established.

The prototype requires REFramework v1.5.9.1 on Rise 16.0.2.0. Install `reframework/autorun/free_arena.lua` and `free_arena_check.lua` in the game's `reframework/autorun` folder while the game is closed. `reframework/quests/q900101.json` is a research artifact and is not loaded at runtime. Run `npm ci` and `npm run check` for syntax checks. Runtime logs and reports are under the game's `reframework` directory.
