// HTTP server: endpoint registration and the cpp-httplib threading model.
// Routes are registered one path at a time: the multi-path initializer_list overload
// matches paths with a regex at request time and once raised an uncaught regex_error.
#include "http_server.h"

#include "memory_bridge.h"

#include "httplib.h"
#include <iphlpapi.h>
#include <netioapi.h>
#include <set>

#include <filesystem>
#include <sstream>

namespace webconsole {

// Wire protocol version shared with src/game/webconsole_bridge.ts and the console UI.
// 4: CLI identity fields, /api/probe/report and per-generation identity.
inline constexpr int PLUGIN_PROTOCOL = 4;

// Process-wide singleton shared by HTTP threads and the Lua module functions.
MemoryBridge& bridge()
{
    static MemoryBridge instance;
    return instance;
}

namespace {

// JSON string escaping for the short values this file assembles (versions, ids, names).
std::string json_escape(const std::string& text)
{
    std::string out;
    out.reserve(text.size() + 8);
    for (const char ch : text) {
        const auto byte = static_cast<unsigned char>(ch);
        if (ch == '"' || ch == '\\') {
            out += '\\';
            out += ch;
        } else if (byte < 0x20) {
            char buf[8] = {};
            std::snprintf(buf, sizeof(buf), "\\u%04x", byte);
            out += buf;
        } else {
//  . ASCII .....UTF-8 ... JSON ......
            out += ch;
        }
    }
    return out;
}

// Only enumerate addresses when the help page asks. No periodic adapter polling.
std::string connection_json()
{
    ULONG size = 16 * 1024;
    std::vector<unsigned char> buffer(size);
    ULONG result = ERROR_BUFFER_OVERFLOW;
    for (int retry = 0; retry < 3 && result == ERROR_BUFFER_OVERFLOW; ++retry) {
        buffer.resize(size);
        result = GetAdaptersAddresses(AF_INET, GAA_FLAG_SKIP_ANYCAST | GAA_FLAG_SKIP_MULTICAST |
            GAA_FLAG_SKIP_DNS_SERVER, nullptr,
            reinterpret_cast<IP_ADAPTER_ADDRESSES*>(buffer.data()), &size);
    }
    std::ostringstream out;
    out << "{\"ok\":true,\"port\":" << g_listen_port
        << ",\"localUrl\":\"http://127.0.0.1:" << g_listen_port << "/console\",\"addresses\":[";
    bool first = true;
    std::set<std::string> seen;
    if (result == NO_ERROR) {
        for (auto* adapter = reinterpret_cast<IP_ADAPTER_ADDRESSES*>(buffer.data()); adapter; adapter = adapter->Next) {
            if (adapter->OperStatus != IfOperStatusUp ||
                (adapter->IfType != IF_TYPE_ETHERNET_CSMACD && adapter->IfType != IF_TYPE_IEEE80211)) continue;
            MIB_IF_ROW2 row = {};
            row.InterfaceLuid = adapter->Luid;
            if (GetIfEntry2(&row) != NO_ERROR || !row.InterfaceAndOperStatusFlags.HardwareInterface) continue;
            std::string name;
            if (adapter->FriendlyName) {
                const int count = WideCharToMultiByte(CP_UTF8, 0, adapter->FriendlyName, -1, nullptr, 0, nullptr, nullptr);
                if (count > 1) {
                    std::vector<char> text(count);
                    WideCharToMultiByte(CP_UTF8, 0, adapter->FriendlyName, -1, text.data(), count, nullptr, nullptr);
                    name = text.data();
                }
            }
            for (auto* addr = adapter->FirstUnicastAddress; addr; addr = addr->Next) {
                if (!addr->Address.lpSockaddr || addr->Address.lpSockaddr->sa_family != AF_INET) continue;
                const auto* ipv4 = reinterpret_cast<const sockaddr_in*>(addr->Address.lpSockaddr);
                const auto host = ntohl(ipv4->sin_addr.s_addr);
                if (host == 0 || (host >> 24) == 127 || (host >> 16) == 0xa9fe) continue;
                char ip[INET_ADDRSTRLEN] = {};
                if (!inet_ntop(AF_INET, &ipv4->sin_addr, ip, sizeof(ip)) || !seen.insert(ip).second) continue;
                if (!first) out << ',';
                first = false;
                out << "{\"adapter\":\"" << json_escape(name) << "\",\"url\":\"http://"
                    << ip << ':' << g_listen_port << "/console\"}";
            }
        }
    }
    out << "],\"enumerationOk\":" << (result == NO_ERROR || result == ERROR_NO_DATA ? "true" : "false") << '}';
    return out.str();
}

// Shared origin check for every POST endpoint: empty Origin (curl, CLI) passes;
// browsers must name this interface or the dev server.
bool origin_ok(const httplib::Request& req)
{
    const auto origin = req.get_header_value("Origin");
    if (origin.empty()) return true;
    const auto expected = std::string("http://127.0.0.1:") + std::to_string(g_listen_port);
    const auto local = std::string("http://localhost:") + std::to_string(g_listen_port);
    // Match the actual destination interface, not an arbitrary client-supplied Host.
    const auto interface_origin = std::string("http://") + req.local_addr + ":" + std::to_string(g_listen_port);
    return origin == expected || origin == local || origin == interface_origin ||
        origin == "http://localhost:5173" || origin == "http://127.0.0.1:5173";
}

// g_game_root is ASCII on every relevant install (Steam library path); validated
// script paths are ASCII by construction, so this narrowing is codepoint-exact.
std::string narrow_path(const std::wstring& wide)
{
    std::string out;
    out.reserve(wide.size());
    for (const wchar_t ch : wide) out += static_cast<char>(ch);
    return out;
}

// The three framework script endpoints answer uniformly when the plugin runs
// outside REFramework (standalone test exe) or on an unforked framework build.
bool script_api_available(std::string& error_body)
{
    const auto* fns = g_plugin_functions;
    if (fns && fns->request_script_reset && fns->run_script && fns->last_script_error) return true;
    error_body = "{\"ok\":false,\"error\":\"framework script API unavailable "
                 "(standalone test build or unforked REFramework)\"}";
    return false;
}

std::string probe_json()
{
    auto& state = bridge();
    const auto uptime = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now() - g_started_at).count();
    std::ostringstream ss;
    ss << "{\"ok\":true"
       << ",\"plugin\":\"webconsole\""
       << ",\"module\":\"webconsole\""
       << ",\"export\":\"luaopen_webconsole\""
       << ",\"moduleVersion\":\"" << json_escape(PLUGIN_VERSION) << "\""
       << ",\"protocol\":" << PLUGIN_PROTOCOL
       << ",\"pid\":" << GetCurrentProcessId()
       << ",\"session\":\"" << json_escape(g_session_id) << "\""
       << ",\"uptimeMs\":" << uptime
       << ",\"sessions\":" << state.epoch()
       << ",\"stateSeq\":" << state.state_sequence()
       << ",\"queuedCommands\":" << state.queued_commands()
       << ",\"commands\":" << g_command_posts.load(std::memory_order_relaxed)
       << ",\"pings\":" << g_ping_calls.load(std::memory_order_relaxed)
       << ",\"transport\":\"memory\"}";
    return ss.str();
}

} // namespace

void run_server()
{
    httplib::Server svr;
    svr.set_payload_max_length(262144);
    svr.set_read_timeout(3);
    svr.set_write_timeout(3);
    svr.set_default_headers({{"Cache-Control", "no-store"}});
    svr.set_exception_handler([](const httplib::Request&, httplib::Response& res, std::exception_ptr) {
        res.status = 500;
        res.set_content("{\"ok\":false,\"error\":\"request failed\"}", "application/json");
    });

    svr.Get("/api/health", [](const httplib::Request&, httplib::Response& res) {
        std::ostringstream ss;
        ss << "{\"ok\":true,\"plugin\":\"webconsole\",\"version\":\"" << PLUGIN_VERSION
           << "\",\"session\":\"" << json_escape(g_session_id) << "\"}";
        res.set_content(ss.str(), "application/json");
    });

    svr.Get("/api/connection", [](const httplib::Request&, httplib::Response& res) {
        res.set_header("Cache-Control", "no-store");
        res.set_content(connection_json(), "application/json");
    });

    // DLL identity endpoint: lets the probe/page separate "DLL up" from "Lua loaded".
    svr.Get("/api/probe", [](const httplib::Request&, httplib::Response& res) {
        res.set_content(probe_json(), "application/json");
    });

    // Probe report published by the Lua probe (module load, roundtrip, GC, session history).
    svr.Get("/api/probe/report", [](const httplib::Request&, httplib::Response& res) {
        const auto body = bridge().probe_snapshot();
        if (body.empty()) {
            res.status = 503;
            res.set_content("{\"ok\":false,\"error\":\"probe has not reported yet\"}", "application/json");
        } else {
            res.set_content(body, "application/json");
        }
    });

    svr.Get("/api/state", [&](const httplib::Request&, httplib::Response& res) {
        const auto body = bridge().state_snapshot(); // straight from process memory, no disk
        if (body.empty()) {
            res.status = 503;
            res.set_content("{\"ok\":false,\"error\":\"Lua bridge has not published state yet\"}", "application/json");
        } else {
            res.set_content(body, "application/json");
        }
    });

    svr.Get("/api/results", [&](const httplib::Request&, httplib::Response& res) {
        const auto body = bridge().results_snapshot();
        if (body.empty()) {
            res.status = 503;
            res.set_content("{\"ok\":false,\"error\":\"Lua bridge has not published results yet\"}", "application/json");
        } else {
            res.set_content(body, "application/json");
        }
    });

    svr.Get("/api/config", [&](const httplib::Request&, httplib::Response& res) {
        static CachedFile cache;
        const auto body = cached_read(cache, data_path(L"mhw_rogue_config.json"), 1000);
        if (body.empty()) {
            res.status = 404;
            res.set_content("{\"ok\":false,\"error\":\"no runtime config override\"}", "application/json");
        } else {
            res.set_content(body, "application/json");
        }
    });

    // Bounded command queue: POST enqueues; Lua pops and publishes results.
    // 256 KB cap leaves room for config submissions.
    svr.Post("/api/command", [](const httplib::Request& req, httplib::Response& res) {
        if (!origin_ok(req)) {
            res.status = 403;
            res.set_content("{\"ok\":false,\"error\":\"origin rejected\"}", "application/json");
            return;
        }
        if (req.get_header_value("Content-Type").find("application/json") != 0) {
            res.status = 415;
            res.set_content("{\"ok\":false,\"error\":\"application/json required\"}", "application/json");
            return;
        }
        if (req.body.size() > 262144) {
            res.status = 413;
            res.set_content("{\"ok\":false,\"error\":\"command too large\"}", "application/json");
            return;
        }
        // Bounded queue: full = 429 (overload guard), never overwrite an accepted command
        if (!bridge().push_command(req.body)) {
            res.status = 429;
            res.set_content("{\"ok\":false,\"error\":\"command queue full; slow down\"}", "application/json");
            return;
        }
        g_command_posts.fetch_add(1, std::memory_order_relaxed);
        std::ostringstream ss;
        ss << "{\"ok\":true,\"queued\":true,\"bytes\":" << req.body.size() << "}";
        res.set_content(ss.str(), "application/json");
    });

    // Script control via the forked framework plugin API (fork commit 2e7ce5b:
    // request_script_reset / run_script / last_script_error). Both POST endpoints
    // queue the work; the game thread performs it inside the next frame.
    svr.Post("/api/script/reset", [](const httplib::Request& req, httplib::Response& res) {
        if (!origin_ok(req)) {
            res.status = 403;
            res.set_content("{\"ok\":false,\"error\":\"origin rejected\"}", "application/json");
            return;
        }
        std::string unavailable;
        if (!script_api_available(unavailable)) {
            res.status = 503;
            res.set_content(unavailable, "application/json");
            return;
        }
        g_plugin_functions->request_script_reset();
        std::ostringstream ss;
        ss << "{\"ok\":true,\"queued\":true,\"action\":\"reset_scripts\""
           << ",\"epoch\":" << bridge().epoch()
           << ",\"session\":\"" << json_escape(g_session_id) << "\"}";
        res.set_content(ss.str(), "application/json");
    });

    svr.Post("/api/script/run", [](const httplib::Request& req, httplib::Response& res) {
        if (!origin_ok(req)) {
            res.status = 403;
            res.set_content("{\"ok\":false,\"error\":\"origin rejected\"}", "application/json");
            return;
        }
        if (req.get_header_value("Content-Type").find("application/json") != 0) {
            res.status = 415;
            res.set_content("{\"ok\":false,\"error\":\"application/json required\"}", "application/json");
            return;
        }
        if (req.body.size() > 262144) {
            res.status = 413;
            res.set_content("{\"ok\":false,\"error\":\"script body too large\"}", "application/json");
            return;
        }
        std::string unavailable;
        if (!script_api_available(unavailable)) {
            res.status = 503;
            res.set_content(unavailable, "application/json");
            return;
        }

        std::string path_value, name_value, content_value;
        const bool has_path = json_find_string(req.body, "path", path_value);
        const bool has_content = json_find_string(req.body, "content", content_value);
        json_find_string(req.body, "name", name_value);

        std::string rel;        // game-root-relative narrow path handed to run_script
        std::string script;     // name reported back to the client
        if (has_path && has_content) {
            res.status = 400;
            res.set_content("{\"ok\":false,\"error\":\"path and content are mutually exclusive\"}", "application/json");
            return;
        } else if (has_path) {
            if (!valid_run_script_path(path_value, rel)) {
                res.status = 400;
                res.set_content("{\"ok\":false,\"error\":\"path must be a relative ASCII "
                    "game-tree path with a .lua suffix\"}", "application/json");
                return;
            }
            script = rel;
            const std::wstring wide = g_game_root + L"\\" + std::wstring(rel.begin(), rel.end());
            std::error_code ec;
            if (!std::filesystem::exists(wide, ec)) {
                res.status = 404;
                res.set_content("{\"ok\":false,\"error\":\"file not found in game tree\"}", "application/json");
                return;
            }
        } else if (has_content) {
            if (!valid_run_script_name(name_value, script)) {
                res.status = 400;
                res.set_content("{\"ok\":false,\"error\":\"content form requires name: one safe "
                    "path component, ASCII, .lua suffix optional\"}", "application/json");
                return;
            }
            const std::wstring runs_dir = g_data_dir + L"\\webconsole_runs";
            std::filesystem::create_directories(runs_dir);
            const std::wstring target = runs_dir + L"\\" + std::wstring(script.begin(), script.end());
            if (!atomic_write_text(target, content_value)) {
                res.status = 500;
                res.set_content("{\"ok\":false,\"error\":\"failed to write script file\"}", "application/json");
                return;
            }
            rel = "reframework/data/webconsole_runs/" + script;
        } else {
            res.status = 400;
            res.set_content("{\"ok\":false,\"error\":\"provide path or content (+name)\"}", "application/json");
            return;
        }

        const std::string absolute = narrow_path(g_game_root) + "\\" + rel;
        if (!g_plugin_functions->run_script(absolute.c_str())) {
            res.status = 500;
            res.set_content("{\"ok\":false,\"error\":\"run_script rejected the path\"}", "application/json");
            return;
        }
        std::ostringstream ss;
        ss << "{\"ok\":true,\"queued\":true,\"script\":\"" << json_escape(script) << "\""
           << ",\"epoch\":" << bridge().epoch()
           << ",\"session\":\"" << json_escape(g_session_id) << "\"}";
        res.set_content(ss.str(), "application/json");
    });

    svr.Get("/api/script/error", [](const httplib::Request&, httplib::Response& res) {
        const auto* fns = g_plugin_functions;
        const bool available = fns && fns->last_script_error;
        char buf[4096] = {};
        bool has = false;
        if (available) has = fns->last_script_error(buf, sizeof(buf));
        std::ostringstream ss;
        ss << "{\"ok\":true,\"available\":" << (available ? "true" : "false")
           << ",\"hasError\":" << (has ? "true" : "false")
           << ",\"error\":\"" << json_escape(has ? buf : "") << "\"}";
        res.set_content(ss.str(), "application/json");
    });

    // Single-file Vue console, same origin as the API (console.html sits next to the DLL).
    svr.Get("/console", [&](const httplib::Request&, httplib::Response& res) {
        std::string html = read_text(g_module_dir + L"\\console.html");
        if (html.empty()) {
            res.status = 404;
            res.set_content(
                "<!doctype html><meta charset='utf-8'><title>MHR webconsole</title>"
                "<p>console.html not deployed. API: /api/health /api/state /api/results /api/config (GET), /api/command (POST).</p>",
                "text/html; charset=utf-8");
            return;
        }
        res.set_content(html, "text/html; charset=utf-8");
    });

    if (!svr.listen("0.0.0.0", g_listen_port)) {
        log_info("listen failed");
    }
}

void start_http_server()
{
    std::thread(run_server).detach();
}

} // namespace webconsole
