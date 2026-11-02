#pragma once
#include <cstdint>
#include <string>
#include <vector>

namespace webconsole {
inline constexpr const char* STEAM_PLAN_KEY = "mhr_arena_entry_v2_plan";
inline constexpr const char* STEAM_ACK_KEY = "mhr_arena_entry_v2_ack";
struct SteamMember { std::string id, ack; };
struct SteamLobby { std::string id, owner, self, plan; std::vector<SteamMember> members; };
struct SteamSnapshot { bool available = false; std::string reason; std::vector<SteamLobby> lobbies; };
// Called only from the host Lua thread. Steam callbacks only enqueue lobby IDs.
SteamSnapshot steam_snapshot();
bool steam_write_plan(const std::string& lobby, const std::string& value);
bool steam_write_ack(const std::string& lobby, const std::string& value);
std::string steam_digest(const std::string& value);
}
