// REFramework native plugin entry: sets up directories, starts the HTTP thread,
// and records the module directory. Game-object work lives in the Lua control
// layer; this DLL only serves the transport.
#include "common.h"
#include "http_server.h"
#include "memory_bridge.h"
#include "lua_bridge.h"
#include "../reframework/API.h"
#include <lua.hpp>

#include <filesystem>

#ifndef WEBCONSOLE_STANDALONE

// Use the module already loaded as a REFramework plugin. Searching for another
// copy under autorun can load a second DLL with a different in-memory queue.
static void on_lua_created(lua_State* L) {
    webconsole::attach_lua_bridge(L);
}

static void on_lua_destroyed(lua_State*) {
    webconsole::bridge().clear_snapshots();
}

extern "C" __declspec(dllexport) void reframework_plugin_required_version(REFrameworkPluginVersion* version) {
    version->major = REFRAMEWORK_PLUGIN_VERSION_MAJOR;
    version->minor = REFRAMEWORK_PLUGIN_VERSION_MINOR;
    version->patch = REFRAMEWORK_PLUGIN_VERSION_PATCH;
}

extern "C" __declspec(dllexport) bool reframework_plugin_initialize(const REFrameworkPluginInitializeParam* param) {
    if (!param || !param->functions) return false;
    // Script-control surface of the forked framework (request_script_reset /
    // run_script / last_script_error); members may still be null on older builds.
    webconsole::g_plugin_functions = param->functions;
    // The installed build (5bae4701) declares log_info as varargs; log_sink is a
    // fixed-signature pointer, so forward through a wrapper. Only one argument
    // is ever passed, which is a legal varargs call.
    // lambdas convert to plain function pointers only when they capture nothing,
    // so stash the table in a static and read it inside the wrapper.
    static const REFrameworkPluginFunctions* functions = param->functions;
    static void (*const sink)(const char*) = [](const char* msg) { functions->log_info("%s", msg); };
    webconsole::log_sink = sink;
    if (!param->functions->on_lua_state_created(on_lua_created) ||
        !param->functions->on_lua_state_destroyed(on_lua_destroyed)) return false;

    // Data dir: <game>/reframework/data, the same target json.dump_file writes to.
    char exe_dir[MAX_PATH] = {};
    GetModuleFileNameA(nullptr, exe_dir, MAX_PATH);
    std::string root = exe_dir;
    const auto slash = root.find_last_of('\\');
    if (slash != std::string::npos) root = root.substr(0, slash);
    webconsole::g_game_root = std::wstring(root.begin(), root.end());
    webconsole::g_data_dir = webconsole::g_game_root + L"\\reframework\\data";
    std::filesystem::create_directories(webconsole::g_data_dir);

    if (!webconsole::configure_instance()) { webconsole::log_info("invalid webconsole instance configuration"); return false; }
    webconsole::start_http_server();
    webconsole::log_info("initialized; http thread starting");
    return true;
}

BOOL APIENTRY DllMain(HMODULE hModule, DWORD reason, LPVOID) {
    if (reason == DLL_PROCESS_ATTACH) {
        // The session id must exist before the first require call or api/probe
        // read; DLL_PROCESS_ATTACH runs before anything else in this DLL.
        webconsole::init_session_id();
        // Record the plugin directory reframework/plugins, where console.html lives.
        wchar_t buf[MAX_PATH] = {};
        if (GetModuleFileNameW(hModule, buf, MAX_PATH) > 0) {
            std::wstring full = buf;
            const auto slash = full.find_last_of(L'\\');
            if (slash != std::wstring::npos) webconsole::g_module_dir = full.substr(0, slash);
        }
    } else if (reason == DLL_PROCESS_DETACH) {
        // The plugin lives for the whole process; nothing is unloaded at runtime.
    }
    return TRUE;
}

#else

// Standalone test process: no game and no REFramework, reproduces every endpoint.
// Usage: webconsole_test.exe [port]
int main(int argc, char** argv)
{
    if (argc > 1) webconsole::g_listen_port = static_cast<unsigned short>(std::stoi(argv[1]));
    wchar_t buf[MAX_PATH] = {};
    GetModuleFileNameW(nullptr, buf, MAX_PATH);
    std::wstring full = buf;
    const auto slash = full.find_last_of(L"\\");
    webconsole::g_module_dir = slash == std::wstring::npos ? full : full.substr(0, slash);
    webconsole::g_data_dir = webconsole::g_module_dir + L"\\testdata";
    webconsole::g_game_root = webconsole::g_module_dir;
    _wmkdir(webconsole::g_data_dir.c_str());
    webconsole::init_session_id();
    webconsole::log_info("standalone webconsole (test mode)");
    webconsole::start_http_server();
    // Block the main thread so the server keeps running.
    for (;;) std::this_thread::sleep_for(std::chrono::seconds(60));
    return 0;
}

#endif
