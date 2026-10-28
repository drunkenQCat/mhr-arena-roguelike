// HTTP server: endpoint registration and the cpp-httplib threading model.
// Routes are registered one path at a time: the multi-path initializer_list overload
// matches paths with a regex at request time and once raised an uncaught regex_error.
#include "http_server.h"

#include "memory_bridge.h"

#include "httplib.h"

#include <sstream>

namespace webconsole {

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
       << ",\"protocol\":3"
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
    // Origin is checked against the real destination interface, not an arbitrary Host.
    // 256 KB cap leaves room for config submissions.
    svr.Post("/api/command", [](const httplib::Request& req, httplib::Response& res) {
        const auto expected = std::string("http://127.0.0.1:") + std::to_string(g_listen_port);
        const auto local = std::string("http://localhost:") + std::to_string(g_listen_port);
        // Match the actual destination interface, not an arbitrary client-supplied Host.
        const auto interface_origin = std::string("http://") + req.local_addr + ":" + std::to_string(g_listen_port);
        const auto origin = req.get_header_value("Origin");
        if (!origin.empty() && origin != expected && origin != local && origin != interface_origin &&
            origin != "http://localhost:5173" && origin != "http://127.0.0.1:5173") {
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
