# Validation plan

## Milestone 0: framework attachment

- Confirm the current REFramework stable build supports the installed Rise build.
- Confirm the autorun script loads, the menu renders, and the reported game name is `mhrise`.
- Capture game version, REFramework commit/tag, and startup log.
- Keep the probe read-only.

## Milestone 1: native quest data

Superseded on 2026-10-16: do not use the native loader/exporter steps below. First validate the Lua free arena described in README and free-arena-validation.md, including counter entry, departure, return and shutdown. Further monster/wave work is deferred until that foundation works.

- Use RiseQuestLoader to export one existing arena quest.
- Preserve an untouched copy and document its quest ID, map, monsters, objectives, timer, and failure conditions.
- Open a copy with the matching Quest Editor release; round-trip save it and compare the JSON.
- Build a custom one-monster arena quest and verify solo acceptance, spawn, objective completion, and normal return.

## Milestone 2: multi-wave feasibility

- First test a fully pre-authored two-wave quest if the quest format supports the desired transitions.
- Separately inspect REFramework-exposed managers and lifecycle callbacks to determine whether a defeated monster can trigger another spawn safely in the same quest.
- Do not call undocumented spawn or timer APIs until their signatures and object lifetime are verified on the installed build.

## Milestone 3: roguelike loop

- Only after Milestone 2: prototype run state, rewards, shop UI, failure/return behavior, and party synchronization.
- Multiplayer tests require the exact same custom quest and loader on every participant. Begin with a private two-player lobby.
- Keep game saves and existing quest data backed up; never overwrite a quest ID during the first prototype.

## Build and test terminology

The initial REFramework mod is Lua, so it has no standalone DLL compile step. `npm run check` uses `luaparse` in Lua 5.1 mode for a syntax parse. Runtime compatibility, callbacks, and UI behavior require the game and are not claimed by this check. Quest JSON cannot be validated against RiseQuestLoader until a known-good quest has been exported from the installed game and the editor version is pinned.
