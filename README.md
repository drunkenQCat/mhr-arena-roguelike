# MHR Free Arena

Start with [agent handoff](docs/HANDOFF-agent.md). The task appeared in the user's counter but crashed before acceptance. A candidate text-hook fix is installed; counter stability and departure remain unverified.

Quest 900101: 自由竞技场 / Free Arena. An independent village expedition derived from original quest 101, on arena map 10, with own equipment, no monsters, no hunting objective and no time limit.

Intended entrance: village receptionist Hinoa (火芽) > 探索任务 > 自由竞技场 / Free Arena. Lua registration and data checks passed; counter visibility, departure and return remain unverified.

## Installation

Requires REFramework v1.5.9.1 on Rise 16.0.2.0. With the game closed, copy reframework/autorun/free_arena.lua and free_arena_check.lua into the game's reframework/autorun directory.

Installed game: C:/Program Files (x86)/Steam/steamapps/common/MonsterHunterRise.

Do not install RiseQuestLoader 1.1.1 for this prototype. It was removed after a crash opening expeditions and archived in .local/disabled-native-loader. The source reframework/quests/q900101.json is a legacy research artifact, unused by the Lua installer.

Run npm ci and npm run check for Lua syntax validation. There is no custom DLL to compile. Runtime reports are in the game's reframework/data/free_arena_install.json and free_arena_status.json. Registration does not prove that departure works.

## Entry and test

1. Load the character, talk to village receptionist 火芽 and open 探索任务. The script should add Free Arena beside original expedition 101; list visibility remains to be verified.
2. Select 自由竞技场 / Free Arena and accept. Follow the on-screen departure prompt and confirm.
3. Verify arena map, own equipment, no monsters and no timer; move around for at least 30 seconds.
4. Use the quest menu to finish the expedition and verify return to village. Exact Chinese option text remains to be verified.

## Shutdown after testing

1. Return to village and wait for saving to finish.
2. Use the game's system menu to return to title, then choose Exit and confirm. Record the actual menu path observed.
3. Verify Get-Process MonsterHunterRise -ErrorAction SilentlyContinue returns no game process.
4. If normal exit cannot be operated, the user authorized PowerShell termination: Get-Process MonsterHunterRise -ErrorAction SilentlyContinue | Stop-Process. Avoid terminating during saving. Record this as forced termination, never normal exit. Alt+F4 is not reliable for this game.

To uninstall, close the game and move free_arena.lua and free_arena_check.lua out of game autorun. The scripts do not edit original quests or saves.
