# Free arena verification — 2026-10-16

## Current Lua backend

- Game 16.0.2.0 / Steam build 17920865; REFramework v1.5.9.1, Lua 5.4.
- Save backup: .local/backups/before-arena; no save edits for this quest.
- Original expedition 101 is cloned into quest 900101 with map 10 and small-monster spawn set 0. Original untimed expedition rules are retained.
- Object allocation initially failed. Passing true as the simplify argument to sdk.create_instance fixed raw data and QuestData allocation.
- At 01:08:09 on October 16 the Lua installer logged successful registration. The independent checker passed map=10, type=32, timer=0 and empty monster slots. The catalogue subsequently captured 79 templates (78 originals plus the custom quest).
- Syntax validation passed. Current reports are archived under evidence/2026-10-16.

Counter visibility, acceptance, departure, arena movement and return remain unverified. Intended route: 火芽 > 探索任务 > 自由竞技场 / Free Arena. The list hook adds the custom ID only when original village expedition 101 is present.

The game is open in the village for entry verification. Computer Use mouse clicks and Insert work, but movement/menu keyboard input has not reliably reached the game. User assistance opening 火芽's expedition list was requested. No normal shutdown is claimed for this session.

## Superseded native backend

RiseQuestLoader 1.1.1 initially registered the quest but the user reported a crash opening expeditions. The 00:41:36 crash dump contains a game access violation and a RiseQuestLoader DLL frame. The old four-argument getQuestTextCore hook differs from the six-argument signature in newer source: a compatibility defect, although the exact crash cause is not conclusively symbolicated.

The DLL and active native quest JSON were moved to .local/disabled-native-loader and are no longer loaded. Crash evidence is in .local/crash-arena-20261016. Older evidence under evidence/2026-10-15 describes the native experiment. Do not use the old Export All Quests or Reload Quests workflow.

Follow README shutdown steps after testing, explicitly recording any PowerShell process termination.

## 2026-10-16 morning: counter crash

User confirmed the custom name appears, then crashes before accepting the quest. Menu visibility is user-confirmed; acceptance/departure remain unverified. The 09:47:32 minidump was archived in .local/crash-lua-arena-20261016. The archived log belongs to the 09:48 restart, not the crashed session. The dump shows an invalid access in object-reference handling but lacks heap memory needed to identify the affected object; root cause remains unproven.

Candidate fix: replace cached managed strings with a fresh frame-local string per text return, and compare QuestData pointer identity instead of calling getQuestNo inside the hook. Syntax checks pass. This follows the fresh-string pattern in RiseQuestLoader source and REFramework issue 1049 (https://github.com/praydog/REFramework/issues/1049). It is a candidate, not a confirmed fix.

Shutdown: after observing the credits screen, process 116340 was terminated using the user's authorized PowerShell method and process absence verified before installation. This was forced termination, not normal exit.

Candidate startup test: 10:01:33 installer and independent data checker passed. Menu automation then entered the unsaved character-creation screen instead of Continue. No character creation was finalized. Escape was ineffective; right-click opened the cancellation prompt, but coordinate clicks did not reliably match the in-game pointer. Runtime counter retest therefore remains pending. Test process 136060 was forcibly stopped with PowerShell; WaitForExit completed and subsequent process query returned none. The game is closed. The installed candidate SHA256 is 2C399E245DD4B9527220DAAF8BD616DBF2B5953E7CE14E14BBA30C71AF3E3B11.
