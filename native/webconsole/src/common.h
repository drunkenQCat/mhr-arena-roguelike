// webconsole shared definitions: version, dirs, logging, file helpers, cached reads.
// Shared by http_server.cpp (endpoints) and plugin_main.cpp / standalone_main.cpp.
// Threading: HTTP runs on the cpp-httplib pool; writes go through a temp file plus
// MoveFileExW; cached reads use a spin lock. Handlers must not throw, because an
// escaping exception calls std::terminate and takes the game process down.
// Keep this file pure ASCII: the toolchain here reads sources in the ANSI code page.
#pragma once
// winsock2.h must precede Windows.h (legacy winsock.h redefines sockaddr).
#include <winsock2.h>
#include <ws2tcpip.h>
#include <Windows.h>

#include <atomic>
#include <cstdio>
#include <cstdlib>
#include <chrono>
#include <deque>
#include <fstream>
#include <mutex>
#include <sstream>
#include <string>
#include <thread>

namespace webconsole {

inline constexpr const char* PLUGIN_VERSION = "0.3.4";
inline unsigned short g_listen_port = 11777;

// Process-wide DLL session id (pid + boot counter tail). Created at
// DLL_PROCESS_ATTACH, stable across ScriptRunner Reset: Reset swaps the Lua
// state, not the process, so consecutive resets share the DLL session while
// each load gets a distinct Lua-side entry.
inline std::string g_session_id;
// /api/probe counters and the uptime origin (atomic, monotonic).
inline std::chrono::steady_clock::time_point g_started_at = std::chrono::steady_clock::now();
inline std::atomic<unsigned long long> g_ping_calls{0};
inline std::atomic<unsigned long long> g_command_posts{0};

inline void init_session_id()
{
    if (!g_session_id.empty()) return;
    LARGE_INTEGER counter{};
    QueryPerformanceCounter(&counter);
    const unsigned long long started = static_cast<unsigned long long>(counter.QuadPart);
    char buf[64] = {};
    std::snprintf(buf, sizeof(buf), "%lu-%llu", GetCurrentProcessId(), started % 10000000000ull);
    g_session_id = buf;
}

// Log sink: the plugin entry points it at the REFramework log, the standalone
// test exe at printf. Empty sink = silent (logs before exit are not guaranteed
// visible anyway).
inline void (*log_sink)(const char*) = nullptr;
inline void log_info(const char* msg) { if (log_sink) log_sink(msg); }

// Data dir = <game>/reframework/data; module dir = reframework/plugins where
// console.html lives. Set once by the entry point, read-only afterwards.
inline std::wstring g_data_dir;
inline std::wstring g_module_dir;
inline std::wstring data_path(const wchar_t* name) { return g_data_dir + L"\\" + name; }

inline std::string read_text(const std::wstring& path) {
    std::ifstream f(path.c_str(), std::ios::binary);
    if (!f.good()) return {};
    std::ostringstream ss;
    ss << f.rdbuf();
    return ss.str();
}

// Atomic text write: temp file plus MoveFileExW (bounded retries on contention).
inline bool atomic_write_text(const std::wstring& path, const std::string& text) {
    const std::wstring tmp = path + L".tmp";
    {
        std::ofstream f(tmp.c_str(), std::ios::binary | std::ios::trunc);
        if (!f.good()) return false;
        f.write(text.data(), static_cast<std::streamsize>(text.size()));
        if (!f.good()) return false;
    }
    for (int attempt = 0; attempt < 5; ++attempt) {
        if (MoveFileExW(tmp.c_str(), path.c_str(), MOVEFILE_REPLACE_EXISTING)) return true;
        Sleep(20);
    }
    DeleteFileW(tmp.c_str());
    return false;
}

// Cached read: all clients share one disk read, throttled by TTL; the spin lock
// guards the cache body (cpp-httplib handlers run concurrently on its thread pool).
struct CachedFile {
    std::atomic_flag spin = ATOMIC_FLAG_INIT;
    std::chrono::steady_clock::time_point last{};
    std::string body;
    bool valid = false;
};

inline std::string cached_read(CachedFile& c, const std::wstring& path, int ttl_ms) {
    while (c.spin.test_and_set(std::memory_order_acquire)) std::this_thread::yield();
    struct Guard {
        std::atomic_flag& f;
        ~Guard() { f.clear(std::memory_order_release); }
    } guard{c.spin};
    const auto now = std::chrono::steady_clock::now();
    if (!c.valid || now - c.last > std::chrono::milliseconds(ttl_ms)) {
        c.body = read_text(path); // a failing ifstream returns empty, it never throws
        c.last = now;
        c.valid = true;
    }
    return c.body;
}

} // namespace webconsole
