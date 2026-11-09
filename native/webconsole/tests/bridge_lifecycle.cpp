#include "common.h"
#include "memory_bridge.h"
#include "lua_bridge.h"
#include <lua.hpp>
#include <stdexcept>
#include <iostream>
#include <filesystem>

static void check(bool ok, const char* message) {
    if (!ok) throw std::runtime_error(message);
}

int main() try {
    const auto journal_directory = std::filesystem::temp_directory_path() /
        (L"mhr-bridge-journal-test-" + std::to_wstring(GetCurrentProcessId()));
    check(std::filesystem::create_directory(journal_directory), "cannot create journal test directory");
    webconsole::g_data_dir = journal_directory.wstring();
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
            assert(type(b.steam_config_payload)=='function' and type(b.steam_config_control)=='function' and type(b.steam_config_ack)=='function')
            assert(b.steam_config_payload('1000','{}')==false) -- No Steam module in this harness.
            assert(not pcall(b.steam_config_payload,'1000',string.rep('x',65537)))
            assert(not pcall(b.steam_config_control,'1000',string.rep('x',2049)))
            assert(b.write_config('mhw_rogue_config.json','{"value":1}')==true)
            assert(b.write_config('mhw_rogue_config_pending.json','{"active":true}')==true)
            assert(b.write_config('mhw_rogue_startup_state.json','{}')==false)
            assert(b.write_config('../escape.json','{}')==false)
            assert(not pcall(b.write_config,'mhw_rogue_config.json',string.rep('x',262145)))
            assert(b.write_recovery('mhw_rogue_startup_state.json', '{"active":true}') == true)
            assert(b.write_recovery('mhw_rogue_pouch_state.json', '{"active":false}') == true)
            assert(b.write_recovery('../escape.json', '{}') == false)
            assert(not pcall(b.write_recovery, 'mhw_rogue_startup_state.json', ''))
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
        check(webconsole::read_text(webconsole::data_path(L"mhw_rogue_startup_state.json")) == "{\"active\":true}",
              "Lua recovery writer did not publish exact contents");
        lua_close(L);
    }
    std::filesystem::remove_all(journal_directory);
    bridge.clear_snapshots();
    for (size_t i = 0; i < webconsole::MemoryBridge::MAX_COMMANDS; ++i)
        check(bridge.push_command("bounded"), "Queue rejected before capacity");
    check(!bridge.push_command("overflow"), "Queue overwrote an accepted request");

    // Script endpoint input validation helpers (pure functions in common.h).
    std::string value;
    check(webconsole::json_find_string("{\"path\":\"a/b.lua\"}", "path", value) && value == "a/b.lua",
        "json_find_string missed a plain value");
    check(webconsole::json_find_string("{\"content\":\"line1\\nline2\\\"q\\\"\\u4e2d\"}", "content", value) &&
        value == "line1\nline2\"q\"\xE4\xB8\xAD", "json_find_string mishandled escapes");
    check(!webconsole::json_find_string("{\"path\":42}", "path", value), "json_find_string accepted a number");
    check(!webconsole::json_find_string("{\"other\":1}", "path", value), "json_find_string invented a key");
    check(webconsole::valid_run_script_name("probe_01", value) && value == "probe_01.lua",
        "valid_run_script_name should append .lua");
    check(!webconsole::valid_run_script_name("../evil", value) &&
        !webconsole::valid_run_script_name("a/b", value) &&
        !webconsole::valid_run_script_name("", value) &&
        !webconsole::valid_run_script_name(std::string(200, 'x'), value),
        "valid_run_script_name accepted an unsafe name");
    check(webconsole::valid_run_script_path("reframework/autorun-probe/x.lua", value) &&
        value == "reframework/autorun-probe/x.lua", "valid_run_script_path rejected a valid path");
    check(!webconsole::valid_run_script_path("C:\\x.lua", value) &&
        !webconsole::valid_run_script_path("/x.lua", value) &&
        !webconsole::valid_run_script_path("a/../b.lua", value) &&
        !webconsole::valid_run_script_path("a/b.txt", value) &&
        !webconsole::valid_run_script_path("\xE4\xB8\xAD.lua", value),
        "valid_run_script_path accepted an unsafe path");

    std::cout << "PASS: 3 native Lua generations, preload, binary echo, GC, errors, singleton, "
                 "queue bounds and script input validation\n";
    return 0;
} catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
}
