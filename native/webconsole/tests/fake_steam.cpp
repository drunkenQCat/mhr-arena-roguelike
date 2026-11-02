// Test-only C ABI peer. Never packaged or deployed to a game.
#include <cstdint>
#include <string>
using Id = std::uint64_t;
class Callback { public: virtual void Run(void*) = 0; virtual void Run(void*, bool, Id) = 0; virtual int GetCallbackSizeBytes() = 0; unsigned char flags = 0; int callback = 0; };
struct Enter { Id lobby; std::uint32_t permissions; bool locked; std::uint32_t response; };
static Callback* listener = nullptr;
static std::string plan, ack;
static Id owner = 100, self = 100;
static bool present = true;
#define API extern "C" __declspec(dllexport)
API void* SteamAPI_SteamMatchmaking_v009() { return reinterpret_cast<void*>(1); }
API void* SteamAPI_SteamUser_v023() { return reinterpret_cast<void*>(2); }
API Id SteamAPI_ISteamUser_GetSteamID(void*) { return self; }
API int SteamAPI_ISteamMatchmaking_GetNumLobbyMembers(void*, Id id) { return id == 1000 && present ? 2 : 0; }
API Id SteamAPI_ISteamMatchmaking_GetLobbyMemberByIndex(void*, Id, int index) { return index == 0 ? 100 : 200; }
API Id SteamAPI_ISteamMatchmaking_GetLobbyOwner(void*, Id) { return owner; }
API const char* SteamAPI_ISteamMatchmaking_GetLobbyData(void*, Id, const char* key) { return std::string(key) == "mhr_arena_entry_v2_plan" ? plan.c_str() : ""; }
API const char* SteamAPI_ISteamMatchmaking_GetLobbyMemberData(void*, Id, Id member, const char*) { return member == self ? ack.c_str() : ""; }
API bool SteamAPI_ISteamMatchmaking_SetLobbyData(void*, Id, const char* key, const char* value) {
    if (std::string(key) != "mhr_arena_entry_v2_plan" || self != owner) return false;
    plan = value; return true;
}
API void SteamAPI_ISteamMatchmaking_SetLobbyMemberData(void*, Id, const char* key, const char* value) { if (std::string(key) == "mhr_arena_entry_v2_ack") ack = value; }
API void SteamAPI_RegisterCallback(Callback* value, int id) { if (id == 504) { listener = value; value->callback = id; } }
API void fake_enter() { Enter data{1000, 0, false, 1}; if (listener) listener->Run(&data); }
API void fake_owner(Id id) { owner = id; }
API void fake_present(bool value) { present = value; }
