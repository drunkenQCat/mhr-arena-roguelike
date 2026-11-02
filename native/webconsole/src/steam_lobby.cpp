#include "common.h"
#include "steam_lobby.h"
#include <wincrypt.h>
#include <algorithm>
#include <charconv>
#include <vector>

namespace webconsole {
namespace {
using Id = std::uint64_t;
// Independent ABI declarations for the Steamworks C exports and callback base.
// Reference: Steamworks SDK steam_api_common.h (CCallbackBase), ISteamMatchmaking.
// No SDK implementation, replacement Steam DLL, Init, Shutdown, or callback pump.
class CallbackAbi {
public:
    virtual void Run(void*) = 0;
    virtual void Run(void*, bool, Id) = 0;
    virtual int GetCallbackSizeBytes() = 0;
    unsigned char flags = 0;
    int callback = 0;
};
static_assert(sizeof(CallbackAbi) == 16);
struct EnterEvent { Id lobby; std::uint32_t permissions; bool locked; std::uint32_t response; };
static_assert(sizeof(EnterEvent) == 24);
std::mutex pending_mutex;
std::vector<Id> pending_lobbies;
class EnterCallback final : public CallbackAbi {
    void Run(void* data) override {
        const auto& event = *static_cast<EnterEvent*>(data);
        if (event.response != 1 || !event.lobby) return;
        std::lock_guard<std::mutex> lock(pending_mutex);
        if (pending_lobbies.size() < 32) pending_lobbies.push_back(event.lobby);
    }
    void Run(void* data, bool failed, Id) override { if (!failed) Run(data); }
    int GetCallbackSizeBytes() override { return sizeof(EnterEvent); }
} enter_callback;

struct Api {
    void* matchmaking = nullptr;
    void* user = nullptr;
    bool registered = false;
    Id (*self)(void*) = nullptr;
    int (*count)(void*, Id) = nullptr;
    Id (*member)(void*, Id, int) = nullptr;
    Id (*owner)(void*, Id) = nullptr;
    const char* (*data)(void*, Id, const char*) = nullptr;
    const char* (*member_data)(void*, Id, Id, const char*) = nullptr;
    bool (*set_data)(void*, Id, const char*, const char*) = nullptr;
    void (*set_member_data)(void*, Id, const char*, const char*) = nullptr;
    void (*register_callback)(CallbackAbi*, int) = nullptr;
    std::vector<Id> lobbies;
} api;

template<class T> T symbol(HMODULE module, const char* name) {
    return reinterpret_cast<T>(GetProcAddress(module, name));
}
bool connect() {
    if (api.registered) return true;
    // GetModuleHandle also locates the Steam DLL mapped from Rise's virtual storage.
    const auto module = GetModuleHandleW(L"steam_api64.dll");
    if (!module) return false;
    using Accessor = void* (*)();
    const auto matchmaking = symbol<Accessor>(module, "SteamAPI_SteamMatchmaking_v009");
    if (!matchmaking) return false;
    api.matchmaking = matchmaking();
    for (auto version : {"SteamAPI_SteamUser_v023", "SteamAPI_SteamUser_v022", "SteamAPI_SteamUser_v021", "SteamAPI_SteamUser_v020"}) {
        const auto accessor = symbol<Accessor>(module, version);
        if (accessor && (api.user = accessor())) break;
    }
    api.self = symbol<decltype(api.self)>(module, "SteamAPI_ISteamUser_GetSteamID");
    api.count = symbol<decltype(api.count)>(module, "SteamAPI_ISteamMatchmaking_GetNumLobbyMembers");
    api.member = symbol<decltype(api.member)>(module, "SteamAPI_ISteamMatchmaking_GetLobbyMemberByIndex");
    api.owner = symbol<decltype(api.owner)>(module, "SteamAPI_ISteamMatchmaking_GetLobbyOwner");
    api.data = symbol<decltype(api.data)>(module, "SteamAPI_ISteamMatchmaking_GetLobbyData");
    api.member_data = symbol<decltype(api.member_data)>(module, "SteamAPI_ISteamMatchmaking_GetLobbyMemberData");
    api.set_data = symbol<decltype(api.set_data)>(module, "SteamAPI_ISteamMatchmaking_SetLobbyData");
    api.set_member_data = symbol<decltype(api.set_member_data)>(module, "SteamAPI_ISteamMatchmaking_SetLobbyMemberData");
    api.register_callback = symbol<decltype(api.register_callback)>(module, "SteamAPI_RegisterCallback");
    if (!api.matchmaking || !api.user || !api.self || !api.count || !api.member || !api.owner || !api.data ||
        !api.member_data || !api.set_data || !api.set_member_data || !api.register_callback) return false;
    api.register_callback(&enter_callback, 504); // LobbyEnter_t
    api.registered = true;
    return true;
}
std::string bounded(const char* value) {
    if (!value) return {};
    const auto size = strnlen_s(value, 2049);
    return size <= 2048 ? std::string(value, size) : std::string{};
}
bool parse_id(const std::string& value, Id& id) {
    const auto result = std::from_chars(value.data(), value.data() + value.size(), id);
    return result.ec == std::errc{} && result.ptr == value.data() + value.size() && id != 0;
}
bool member_of(Id lobby, Id self) {
    const auto count = api.count(api.matchmaking, lobby);
    if (count < 1 || count > 4) return false;
    for (int i = 0; i < count; ++i) if (api.member(api.matchmaking, lobby, i) == self) return true;
    return false;
}
bool writable(const std::string& text, const std::string& value, Id& lobby) {
    if (value.size() > 2048 || value.find('\0') != std::string::npos || !connect() || !parse_id(text, lobby)) return false;
    const auto self = api.self(api.user);
    return self && std::find(api.lobbies.begin(), api.lobbies.end(), lobby) != api.lobbies.end() && member_of(lobby, self);
}
}

SteamSnapshot steam_snapshot() {
    SteamSnapshot out;
    if (!connect()) { out.reason = "Steam matchmaking exports are not ready or unsupported"; return out; }
    out.available = true;
    {
        std::lock_guard<std::mutex> lock(pending_mutex);
        for (auto id : pending_lobbies) if (std::find(api.lobbies.begin(), api.lobbies.end(), id) == api.lobbies.end()) api.lobbies.push_back(id);
        pending_lobbies.clear();
    }
    const auto self = api.self(api.user);
    api.lobbies.erase(std::remove_if(api.lobbies.begin(), api.lobbies.end(), [self](Id id) { return !member_of(id, self); }), api.lobbies.end());
    for (auto id : api.lobbies) {
        SteamLobby lobby{std::to_string(id), std::to_string(api.owner(api.matchmaking, id)), std::to_string(self), bounded(api.data(api.matchmaking, id, STEAM_PLAN_KEY)), {}};
        const auto count = api.count(api.matchmaking, id);
        for (int i = 0; i < count; ++i) {
            const auto member = api.member(api.matchmaking, id, i);
            lobby.members.push_back({std::to_string(member), bounded(api.member_data(api.matchmaking, id, member, STEAM_ACK_KEY))});
        }
        out.lobbies.push_back(std::move(lobby));
    }
    if (out.lobbies.empty()) out.reason = "No active lobby observed; create or rejoin the game lobby after the plugin loaded";
    return out;
}
bool steam_write_plan(const std::string& text, const std::string& value) {
    Id lobby = 0;
    if (!writable(text, value, lobby) || api.owner(api.matchmaking, lobby) != api.self(api.user)) return false;
    return api.set_data(api.matchmaking, lobby, STEAM_PLAN_KEY, value.c_str());
}
bool steam_write_ack(const std::string& text, const std::string& value) {
    Id lobby = 0;
    if (!writable(text, value, lobby)) return false;
    api.set_member_data(api.matchmaking, lobby, STEAM_ACK_KEY, value.c_str());
    return true; // Local submission only. Peers must observe the matching value.
}
std::string steam_digest(const std::string& value) {
    HCRYPTPROV provider = 0; HCRYPTHASH hash = 0;
    if (!CryptAcquireContextW(&provider, nullptr, nullptr, PROV_RSA_AES, CRYPT_VERIFYCONTEXT)) return {};
    std::string result;
    if (CryptCreateHash(provider, CALG_SHA_256, 0, 0, &hash)) {
        if (CryptHashData(hash, reinterpret_cast<const BYTE*>(value.data()), static_cast<DWORD>(value.size()), 0)) {
            BYTE bytes[32]{}; DWORD size = sizeof(bytes);
            if (CryptGetHashParam(hash, HP_HASHVAL, bytes, &size, 0)) {
                static constexpr char digits[] = "0123456789abcdef";
                for (auto byte : bytes) { result += digits[byte >> 4]; result += digits[byte & 15]; }
            }
        }
        CryptDestroyHash(hash);
    }
    CryptReleaseContext(provider, 0);
    return result;
}
}
