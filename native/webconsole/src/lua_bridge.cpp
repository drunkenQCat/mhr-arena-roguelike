// Lua C module entry point: luaopen_webconsole.
// Naming contract (all three must match, otherwise require() reports
// "no field package.preload" or loadlib fails):
//   DLL file name webconsole.dll == require("webconsole") == exported luaopen_webconsole
// Plugin initialization registers package.preload on each host Lua creation;
// the installed framework does not search plugins/ through package.cpath.
//
// The module is compiled against the Lua 5.4 sources vendored in lua54/ (same
// version as REFramework's bundled Lua) and operates on the lua_State the host
// passes in. Source/config compatibility still requires host GC/reset validation.
//
// Registered bridge functions (backed by the process-wide MemoryBridge singleton;
// HTTP threads and Lua sit on opposite sides of its lock):
//   webconsole.ping(s)                -> s          connectivity check (echo)
//   webconsole.version()              -> "0.3.2"    module version shown by the probe
//   webconsole.session_id()           -> string     DLL session id (stable across Lua Reset)
//   webconsole.take_commands(max)     -> table      pop up to max queued command JSON strings
//   webconsole.publish_state(json)    -> void       publish the state snapshot
//   webconsole.publish_results(json)  -> void       publish the result table
//   webconsole.publish_probe(json)    -> void       publish the module probe report
//   webconsole.begin_session(epoch)   -> epoch      start a new generation (clears queue)
//   webconsole.epoch()                -> n          current generation
//   webconsole.gc()                   -> void       collectgarbage("collect") passthrough

#include "common.h"
#include "memory_bridge.h"
#include "lua_bridge.h"
#include "steam_lobby.h"
#include "recovery_file.h"

#include <lua.hpp>

namespace {

// Bridge singleton lives in http_server.cpp; DLL and standalone exe each link one copy.
webconsole::MemoryBridge& g_bridge = webconsole::bridge();

int lua_version(lua_State* L)
{
    lua_pushstring(L, webconsole::PLUGIN_VERSION);
    return 1;
}

int lua_session_id(lua_State* L)
{
    lua_pushstring(L, webconsole::g_session_id.c_str());
    return 1;
}

int lua_ping(lua_State* L)
{
    webconsole::g_ping_calls.fetch_add(1, std::memory_order_relaxed);
    size_t len = 0;
    const char* s = luaL_checklstring(L, 1, &len);
    lua_pushlstring(L, s, len);
    return 1;
}

int lua_take_commands(lua_State* L)
{
    const lua_Integer max = luaL_optinteger(L, 1, 8);
    luaL_argcheck(L, max >= 0 && max <= 8, 1, "expected a limit from 0 to 8");
    lua_newtable(L);
    lua_Integer index = 1;
    std::string out;
    while (index <= max && g_bridge.pop_command(out)) {
        lua_pushlstring(L, out.data(), out.size());
        lua_rawseti(L, -2, static_cast<lua_Integer>(index));
        ++index;
    }
    return 1;
}

int lua_publish_state(lua_State* L)
{
    size_t len = 0;
    const char* s = luaL_checklstring(L, 1, &len);
    g_bridge.publish_state(std::string(s, len));
    return 0;
}

int lua_publish_probe(lua_State* L)
{
    size_t len = 0;
    const char* s = luaL_checklstring(L, 1, &len);
    g_bridge.publish_probe(std::string(s, len));
    return 0;
}

int lua_publish_results(lua_State* L)
{
    size_t len = 0;
    const char* s = luaL_checklstring(L, 1, &len);
    g_bridge.publish_results(std::string(s, len));
    return 0;
}

int lua_begin_session(lua_State* L)
{
    const lua_Integer epoch = luaL_checkinteger(L, 1);
    g_bridge.begin_session(static_cast<unsigned long long>(epoch));
    lua_pushinteger(L, epoch);
    return 1;
}

int lua_epoch(lua_State* L)
{
    lua_pushinteger(L, static_cast<lua_Integer>(g_bridge.epoch()));
    return 1;
}

int lua_gc(lua_State* L)
{
    lua_gc(L, LUA_GCCOLLECT, 0);
    return 0;
}

int lua_steam_snapshot(lua_State* L) {
    const auto snapshot = webconsole::steam_snapshot();
    lua_newtable(L);
    lua_pushboolean(L, snapshot.available); lua_setfield(L, -2, "available");
    lua_pushlstring(L, snapshot.reason.data(), snapshot.reason.size()); lua_setfield(L, -2, "reason");
    lua_newtable(L);
    int index = 1;
    for (const auto& lobby : snapshot.lobbies) {
        lua_newtable(L);
        for (const auto& pair : {std::pair{"id", &lobby.id}, {"owner", &lobby.owner}, {"self", &lobby.self}, {"plan", &lobby.plan}}) {
            lua_pushlstring(L, pair.second->data(), pair.second->size()); lua_setfield(L, -2, pair.first);
        }
        lua_newtable(L); int member_index = 1;
        for (const auto& member : lobby.members) {
            lua_newtable(L);
            lua_pushlstring(L, member.id.data(), member.id.size()); lua_setfield(L, -2, "id");
            lua_pushlstring(L, member.ack.data(), member.ack.size()); lua_setfield(L, -2, "ack");
            lua_rawseti(L, -2, member_index++);
        }
        lua_setfield(L, -2, "members"); lua_rawseti(L, -2, index++);
    }
    lua_setfield(L, -2, "lobbies"); return 1;
}
int lua_steam_write(lua_State* L, bool plan) {
    size_t id_len = 0, value_len = 0;
    const auto* id = luaL_checklstring(L, 1, &id_len);
    const auto* value = luaL_checklstring(L, 2, &value_len);
    luaL_argcheck(L, id_len > 0 && id_len <= 20, 1, "invalid lobby ID");
    luaL_argcheck(L, value_len <= 2048, 2, "lobby payload exceeds 2048 bytes");
    const bool ok = plan ? webconsole::steam_write_plan(std::string(id, id_len), std::string(value, value_len))
        : webconsole::steam_write_ack(std::string(id, id_len), std::string(value, value_len));
    lua_pushboolean(L, ok); return 1;
}
int lua_steam_plan(lua_State* L) { return lua_steam_write(L, true); }
int lua_steam_ack(lua_State* L) { return lua_steam_write(L, false); }
int lua_steam_digest(lua_State* L) {
    size_t length = 0; const auto* value = luaL_checklstring(L, 1, &length);
    luaL_argcheck(L, length <= 262144, 1, "descriptor too large");
    const auto hash = webconsole::steam_digest(std::string(value, length));
    lua_pushlstring(L, hash.data(), hash.size()); return 1;
}

int lua_write_recovery(lua_State* L) {
    size_t name_length = 0, body_length = 0;
    const auto* name = luaL_checklstring(L, 1, &name_length);
    const auto* body = luaL_checklstring(L, 2, &body_length);
    luaL_argcheck(L, name_length <= 64, 1, "invalid recovery filename");
    luaL_argcheck(L, body_length > 0 && body_length <= 2 * 1024 * 1024, 2, "recovery record too large or empty");
    bool ok = false;
    try { ok = webconsole::write_recovery(std::string(name, name_length), std::string(body, body_length)); }
    catch (...) { /* Do not propagate C++ exceptions through the host Lua state. */ }
    lua_pushboolean(L, ok); return 1;
}

const luaL_Reg MODULE_FUNCS[] = {
    { "write_recovery", lua_write_recovery },
    { "steam_snapshot", lua_steam_snapshot },
    { "steam_plan", lua_steam_plan },
    { "steam_ack", lua_steam_ack },
    { "steam_digest", lua_steam_digest },
    { "ping", lua_ping },
    { "version", lua_version },
    { "session_id", lua_session_id },
    { "take_commands", lua_take_commands },
    { "publish_state", lua_publish_state },
    { "publish_results", lua_publish_results },
    { "publish_probe", lua_publish_probe },
    { "begin_session", lua_begin_session },
    { "epoch", lua_epoch },
    { "gc", lua_gc },
    { nullptr, nullptr },
};

} // namespace

extern "C" __declspec(dllexport) int luaopen_webconsole(lua_State* L)
{
    luaL_newlib(L, MODULE_FUNCS);
    return 1;
}

void webconsole::attach_lua_bridge(lua_State* L) {
    auto& memory = bridge();
    memory.begin_session(memory.epoch() + 1);
    lua_getglobal(L, "package");
    lua_getfield(L, -1, "preload");
    lua_pushcfunction(L, luaopen_webconsole);
    lua_setfield(L, -2, "webconsole");
    lua_pop(L, 2);
}
