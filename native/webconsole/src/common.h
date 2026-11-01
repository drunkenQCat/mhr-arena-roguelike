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
#include <cctype>
#include <cstdio>
#include <cstdlib>
#include <chrono>
#include <deque>
#include <fstream>
#include <mutex>
#include <sstream>
#include <string>
#include <thread>

#include "../reframework/API.h"

namespace webconsole {

inline constexpr const char* PLUGIN_VERSION = "0.3.6";
inline unsigned short g_listen_port = 11777;

// REFramework plugin functions (request_script_reset / run_script / last_script_error).
// Set once by reframework_plugin_initialize before the HTTP thread starts; null in
// the standalone test process, where the framework endpoints answer 503.
inline const REFrameworkPluginFunctions* g_plugin_functions = nullptr;

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
// console.html lives. Game root is the directory holding reframework/. All are
// set once by the entry point, read-only afterwards.
inline std::wstring g_data_dir;
inline std::wstring g_module_dir;
inline std::wstring g_game_root;
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

// Minimal JSON string-field extractor for the small flat request bodies this
// plugin accepts. Finds "key" and decodes its string value (standard escapes,
// \uXXXX including surrogate pairs) into out. Returns false when the key is
// absent or its value is not a string. Not a general JSON parser: nested
// objects are never searched.
inline bool json_find_string(const std::string& body, const char* key, std::string& out)
{
    const std::string needle = "\"" + std::string(key) + "\"";
    size_t at = body.find(needle);
    while (at != std::string::npos) {
        size_t p = at + needle.size();
        while (p < body.size() && (body[p] == ' ' || body[p] == '\t' || body[p] == '\r' || body[p] == '\n')) ++p;
        if (p < body.size() && body[p] == ':') {
            ++p;
            while (p < body.size() && (body[p] == ' ' || body[p] == '\t' || body[p] == '\r' || body[p] == '\n')) ++p;
            if (p < body.size() && body[p] == '"') {
                ++p;
                out.clear();
                while (p < body.size()) {
                    const char ch = body[p++];
                    if (ch == '"') return true;
                    if (ch != '\\') { out += ch; continue; }
                    if (p >= body.size()) return false;
                    const char esc = body[p++];
                    switch (esc) {
                        case '"': out += '"'; break;
                        case '\\': out += '\\'; break;
                        case '/': out += '/'; break;
                        case 'b': out += '\b'; break;
                        case 'f': out += '\f'; break;
                        case 'n': out += '\n'; break;
                        case 'r': out += '\r'; break;
                        case 't': out += '\t'; break;
                        case 'u': {
                            if (p + 4 > body.size()) return false;
                            unsigned code = 0;
                            for (int i = 0; i < 4; ++i) {
                                const char hex = body[p++];
                                code <<= 4;
                                if (hex >= '0' && hex <= '9') code |= hex - '0';
                                else if (hex >= 'a' && hex <= 'f') code |= hex - 'a' + 10;
                                else if (hex >= 'A' && hex <= 'F') code |= hex - 'A' + 10;
                                else return false;
                            }
                            if (code >= 0xD800 && code <= 0xDBFF && p + 6 <= body.size() &&
                                body[p] == '\\' && body[p + 1] == 'u') {
                                unsigned low = 0;
                                size_t q = p + 2;
                                bool ok_low = true;
                                for (int i = 0; i < 4; ++i) {
                                    const char hex = body[q++];
                                    low <<= 4;
                                    if (hex >= '0' && hex <= '9') low |= hex - '0';
                                    else if (hex >= 'a' && hex <= 'f') low |= hex - 'a' + 10;
                                    else if (hex >= 'A' && hex <= 'F') low |= hex - 'A' + 10;
                                    else { ok_low = false; break; }
                                }
                                if (ok_low && low >= 0xDC00 && low <= 0xDFFF) {
                                    code = 0x10000 + ((code - 0xD800) << 10) + (low - 0xDC00);
                                    p = q;
                                }
                            }
                            if (code < 0x80) out += static_cast<char>(code);
                            else if (code < 0x800) {
                                out += static_cast<char>(0xC0 | (code >> 6));
                                out += static_cast<char>(0x80 | (code & 0x3F));
                            } else if (code < 0x10000) {
                                out += static_cast<char>(0xE0 | (code >> 12));
                                out += static_cast<char>(0x80 | ((code >> 6) & 0x3F));
                                out += static_cast<char>(0x80 | (code & 0x3F));
                            } else {
                                out += static_cast<char>(0xF0 | (code >> 18));
                                out += static_cast<char>(0x80 | ((code >> 12) & 0x3F));
                                out += static_cast<char>(0x80 | ((code >> 6) & 0x3F));
                                out += static_cast<char>(0x80 | (code & 0x3F));
                            }
                            break;
                        }
                        default: return false;
                    }
                }
                return false; // unterminated string
            }
        }
        at = body.find(needle, at + 1);
    }
    return false;
}

// A run-script file name must be one safe path component: ASCII, starting with
// an alphanumeric, no separators, no ".."; the .lua suffix is added when
// missing. On success out holds the normalized name.
inline bool valid_run_script_name(const std::string& name, std::string& out)
{
    out.clear();
    if (name.empty() || name.size() > 128) return false;
    if (!std::isalnum(static_cast<unsigned char>(name[0]))) return false;
    for (const char ch : name) {
        const auto b = static_cast<unsigned char>(ch);
        if (!(std::isalnum(b) || ch == '_' || ch == '-' || ch == '.')) return false;
    }
    if (name.find("..") != std::string::npos) return false;
    out = name;
    if (out.size() < 4 || out.compare(out.size() - 4, 4, ".lua") != 0) out += ".lua";
    return true;
}

// A submitted script path must be a relative game-tree path: ASCII printable,
// no drive letter or colon, no leading separator, no "." / ".." / empty
// segments, .lua suffix. The narrow/wide forms are then trivially equivalent,
// which keeps the framework's ACP-semantics run_script call safe.
inline bool valid_run_script_path(const std::string& path, std::string& out)
{
    out.clear();
    if (path.empty() || path.size() > 512) return false;
    if (path.find(':') != std::string::npos) return false;
    if (path[0] == '/' || path[0] == '\\') return false;
    for (const char ch : path) {
        const auto b = static_cast<unsigned char>(ch);
        if (b < 0x20 || b >= 0x7F) return false;
    }
    size_t start = 0;
    for (;;) {
        const size_t slash = path.find_first_of("/\\", start);
        const std::string seg = path.substr(start,
            slash == std::string::npos ? std::string::npos : slash - start);
        if (seg.empty() || seg == "." || seg == "..") return false;
        if (slash == std::string::npos) break;
        start = slash + 1;
    }
    if (path.size() < 4 || path.compare(path.size() - 4, 4, ".lua") != 0) return false;
    out = path;
    return true;
}

} // namespace webconsole
