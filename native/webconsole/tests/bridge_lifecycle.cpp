#include "common.h"
#include "memory_bridge.h"
#include "lua_bridge.h"
#include <lua.hpp>
#include <stdexcept>
#include <iostream>

static void check(bool ok, const char* message) {
    if (!ok) throw std::runtime_error(message);
}

int main() try {
    webconsole::init_session_id();
    auto& bridge = webconsole::bridge();
    for (int generation = 1; generation <= 3; ++generation) {
        auto* L = luaL_newstate();
        luaL_openlibs(L);
        bridge.push_command("stale");
        webconsole::attach_lua_bridge(L);
        check(bridge.epoch() == generation, "Lua epoch did not advance");
        check(bridge.queued_commands() == 0 && bridge.state_snapshot().empty() &&
            bridge.results_snapshot().empty() && bridge.probe_snapshot().empty(), "Old epoch survived");
        bridge.push_command("request-1");
        const char* code = R"(
            local b = require('webconsole')
            local payload = 'hello\0\1\255'
            assert(b.ping(payload) == payload)
            collectgarbage('collect')
            assert(b.ping(payload) == payload)
            assert(not pcall(b.ping, {}))
            assert(not pcall(b.take_commands, 999))
            assert(b.take_commands(1)[1] == 'request-1')
            b.publish_state('state')
            b.publish_results('result')
            b.publish_probe('probe')
        )";
        if (luaL_dostring(L, code) != LUA_OK) {
            std::cerr << lua_tostring(L, -1) << '\n';
            lua_close(L);
            return 1;
        }
        check(bridge.state_snapshot() == "state" && bridge.results_snapshot() == "result" &&
            bridge.probe_snapshot() == "probe", "Lua/HTTP storage singleton differs");
        lua_close(L);
    }
    bridge.clear_snapshots();
    for (size_t i = 0; i < webconsole::MemoryBridge::MAX_COMMANDS; ++i)
        check(bridge.push_command("bounded"), "Queue rejected before capacity");
    check(!bridge.push_command("overflow"), "Queue overwrote an accepted request");
    std::cout << "PASS: 3 native Lua generations, preload, binary echo, GC, errors, singleton and queue bounds\n";
    return 0;
} catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
}
