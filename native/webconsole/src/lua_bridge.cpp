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

const luaL_Reg MODULE_FUNCS[] = {
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
