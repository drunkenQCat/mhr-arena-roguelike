#pragma once
#include <cstdint>
#include <cstddef>
#include <string>
#include <vector>

namespace webconsole {
inline constexpr const char* STEAM_PLAN_KEY = "mhr_arena_entry_v2_plan";
inline constexpr const char* STEAM_ACK_KEY = "mhr_arena_entry_v2_ack";
inline constexpr const char* STEAM_CONFIG_CONTROL_KEY = "mhr_arena_config_v1_control";
inline constexpr const char* STEAM_CONFIG_MANIFEST_KEY = "mhr_arena_config_v1_manifest";
inline constexpr const char* STEAM_CONFIG_ACK_KEY = "mhr_arena_config_v1_ack";
inline constexpr std::size_t STEAM_CONFIG_MAX_BYTES = 65536;
struct SteamConfig { std::string control, payload, digest; bool complete = false; };
struct SteamMember { std::string id, ack, config_ack; };
struct SteamLobby { std::string id, owner, self, plan; std::vector<SteamMember> members; SteamConfig config; };
struct SteamSnapshot { bool available = false; std::string reason; std::vector<SteamLobby> lobbies; };
// Called only from the host Lua thread. Steam callbacks only enqueue lobby IDs.
SteamSnapshot steam_snapshot();
bool steam_write_plan(const std::string& lobby, const std::string& value);
bool steam_write_ack(const std::string& lobby, const std::string& value);
bool steam_write_config_payload(const std::string& lobby, const std::string& value);
bool steam_write_config_control(const std::string& lobby, const std::string& value);
bool steam_write_config_ack(const std::string& lobby, const std::string& value);
std::string steam_digest(const std::string& value);
}
