import { getSingleton, questManager } from "./sdk";
import { readLobbyIdentity } from "./multiplayer_entry";

/** Native facts only; the run coordinator additionally pins the Steam owner/roster. */
export function multiplayerScope(role?: "host" | "guest"): boolean {
  try {
    const q = questManager(), lobby = getSingleton("snow.LobbyManager");
    const who = readLobbyIdentity().role;
    const count = lobby?.call("getQuestPlayerCount") as number;
    return !!q && q.call("get_ActiveQuestNo") === 900103 &&
      (who === "host" || who === "guest") && (!role || role === who) &&
      Number.isInteger(count) && count >= 1 && count <= 4;
  } catch { return false; }
}
