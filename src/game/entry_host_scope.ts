import { getSingleton, questManager, type REManagedObject } from "./sdk";

/** Local host integration slice, not multiplayer synchronization. Fail closed if
 * any real teammate joins; native online facts remain unchanged in snapshots. */
export function entryHostTestScope(): boolean {
  try {
    const q = questManager(), lobby = getSingleton("snow.LobbyManager");
    if (!q || !lobby || q.call("get_ActiveQuestNo") !== 900103 || lobby.call("getQuestPlayerCount") !== 1) return false;
    const index = (name: string): number | null => {
      const v = lobby.call(name) as REManagedObject | null;
      return v?.get_field("_HasValue") === true ? v.get_field("_Value") as number : null;
    };
    const host = index("getHostIndex"), self = index("getMyLobbyIndex");
    return host !== null && host === self;
  } catch { return false; }
}
