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
constexpr size_t CONFIG_CHUNK_BYTES = 1800;
constexpr size_t CONFIG_MAX_CHUNKS = 49; // ceil(base64(65536) / 1800).
std::string chunk_key(size_t index) { return "mhr_arena_config_v1_part_" + std::to_string(index); }
std::string encode_payload(const std::string& value) {
    DWORD length = 0;
    if (!CryptBinaryToStringA(reinterpret_cast<const BYTE*>(value.data()), static_cast<DWORD>(value.size()),
                              CRYPT_STRING_BASE64 | CRYPT_STRING_NOCRLF, nullptr, &length)) return {};
    std::string encoded(length, '\0');
    if (!CryptBinaryToStringA(reinterpret_cast<const BYTE*>(value.data()), static_cast<DWORD>(value.size()),
                              CRYPT_STRING_BASE64 | CRYPT_STRING_NOCRLF, encoded.data(), &length)) return {};
    encoded.resize(length);
    if (!encoded.empty() && encoded.back() == '\0') encoded.pop_back();
    return encoded;
}
bool number(const std::string& value, size_t& out) {
    const auto result = std::from_chars(value.data(), value.data() + value.size(), out);
    return !value.empty() && result.ec == std::errc{} && result.ptr == value.data() + value.size();
}
SteamConfig read_config(Id lobby) {
    SteamConfig out;
    out.control = bounded(api.data(api.matchmaking, lobby, STEAM_CONFIG_CONTROL_KEY));
    const auto manifest = bounded(api.data(api.matchmaking, lobby, STEAM_CONFIG_MANIFEST_KEY));
    // A complete manifest seals ALL chunks, not just the most recent local write.
    // Steam may deliver the manifest before some parts or retain old cached parts.
    const auto first = manifest.find('|'), second = manifest.find('|', first == std::string::npos ? first : first + 1);
    const auto third = manifest.find('|', second == std::string::npos ? second : second + 1);
    if (first != 2 || manifest.substr(0, first) != "C1" || second == std::string::npos || third == std::string::npos) return out;
    size_t count = 0, bytes = 0;
    if (!number(manifest.substr(first + 1, second - first - 1), count) || count == 0 || count > CONFIG_MAX_CHUNKS ||
        !number(manifest.substr(second + 1, third - second - 1), bytes) || bytes == 0 || bytes > STEAM_CONFIG_MAX_BYTES) return out;
    const auto digest = manifest.substr(third + 1);
    if (digest.size() != 64 || digest.find_first_not_of("0123456789abcdef") != std::string::npos) return out;
    const size_t encoded_size = ((bytes + 2) / 3) * 4;
    if (count != (encoded_size + CONFIG_CHUNK_BYTES - 1) / CONFIG_CHUNK_BYTES) return out;
    std::string encoded;
    encoded.reserve(encoded_size);
    for (size_t i = 0; i < count; ++i) {
        const auto part = bounded(api.data(api.matchmaking, lobby, chunk_key(i).c_str()));
        const auto wanted = (std::min)(CONFIG_CHUNK_BYTES, encoded_size - encoded.size());
        if (part.size() != wanted || part.find_first_not_of("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=") != std::string::npos) return out;
        encoded += part;
    }
    DWORD decoded_size = static_cast<DWORD>(STEAM_CONFIG_MAX_BYTES);
    std::string payload(STEAM_CONFIG_MAX_BYTES, '\0');
    if (!CryptStringToBinaryA(encoded.c_str(), static_cast<DWORD>(encoded.size()), CRYPT_STRING_BASE64,
                              reinterpret_cast<BYTE*>(payload.data()), &decoded_size, nullptr, nullptr)) return out;
    payload.resize(decoded_size);
    if (payload.size() != bytes || payload.find('\0') != std::string::npos || steam_digest(payload) != digest) return out;
    out.complete = true; out.digest = digest; out.payload = std::move(payload);
    return out;
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
            lobby.members.push_back({std::to_string(member), bounded(api.member_data(api.matchmaking, id, member, STEAM_ACK_KEY)),
                                    bounded(api.member_data(api.matchmaking, id, member, STEAM_CONFIG_ACK_KEY))});
        }
        lobby.config = read_config(id);
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
bool steam_write_config_control(const std::string& text, const std::string& value) {
    Id lobby = 0;
    if (!writable(text, value, lobby) || api.owner(api.matchmaking, lobby) != api.self(api.user)) return false;
    return api.set_data(api.matchmaking, lobby, STEAM_CONFIG_CONTROL_KEY, value.c_str());
}
bool steam_write_config_ack(const std::string& text, const std::string& value) {
    Id lobby = 0;
    if (!writable(text, value, lobby)) return false;
    api.set_member_data(api.matchmaking, lobby, STEAM_CONFIG_ACK_KEY, value.c_str());
    return true;
}
bool steam_write_config_payload(const std::string& text, const std::string& value) {
    Id lobby = 0;
    // Membership/ownership are checked before encoding, and again by Steam on
    // every owner-only write. Never expose caller-controlled Steam metadata keys.
    if (value.empty() || value.size() > STEAM_CONFIG_MAX_BYTES || value.find('\0') != std::string::npos ||
        !writable(text, "", lobby) || api.owner(api.matchmaking, lobby) != api.self(api.user)) return false;
    const auto encoded = encode_payload(value), digest = steam_digest(value);
    if (encoded.empty() || digest.size() != 64) return false;
    const auto count = (encoded.size() + CONFIG_CHUNK_BYTES - 1) / CONFIG_CHUNK_BYTES;
    if (count == 0 || count > CONFIG_MAX_CHUNKS) return false;
    for (size_t i = 0; i < count; ++i) {
        const auto part = encoded.substr(i * CONFIG_CHUNK_BYTES, CONFIG_CHUNK_BYTES);
        if (!api.set_data(api.matchmaking, lobby, chunk_key(i).c_str(), part.c_str())) return false;
    }
    const auto manifest = "C1|" + std::to_string(count) + "|" + std::to_string(value.size()) + "|" + digest;
    return api.set_data(api.matchmaking, lobby, STEAM_CONFIG_MANIFEST_KEY, manifest.c_str());
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
