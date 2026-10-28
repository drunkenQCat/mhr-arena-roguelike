// HTTP 服务器实现：全部端点注册与 cpp-httplib 线程模型。
// 路由注册必须逐个单路径——多路径 initializer_list 重载在请求处理时走 regex
// 匹配路径，曾触发未捕获 regex_error 导致进程 terminate（实机崩溃教训）。
#include "http_server.h"

#include "httplib.h"

#include <sstream>

namespace webconsole {

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
        ss << "{\"ok\":true,\"plugin\":\"webconsole\",\"version\":\"" << PLUGIN_VERSION << "\"}";
        res.set_content(ss.str(), "application/json");
    });

    svr.Get("/api/state", [&](const httplib::Request&, httplib::Response& res) {
        static CachedFile cache;
        const auto body = cached_read(cache, data_path(L"webconsole_state.json"), 200);
        if (body.empty()) {
            res.status = 503;
            res.set_content("{\"ok\":false,\"error\":\"state file not written yet\"}", "application/json");
        } else {
            res.set_content(body, "application/json");
        }
    });

    svr.Get("/api/results", [&](const httplib::Request&, httplib::Response& res) {
        static CachedFile cache;
        const auto body = cached_read(cache, data_path(L"webconsole_results.json"), 200);
        if (body.empty()) {
            res.status = 503;
            res.set_content("{\"ok\":false,\"error\":\"results file not written yet\"}", "application/json");
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

    // 单命令槽：POST 覆盖式写入；Lua 执行后写结果文件并清空槽。
    // Origin 校验匹配真实目的接口而非任意客户端 Host；上限 256KB 容纳配置提交。
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
        const std::wstring cmd = data_path(L"webconsole_cmd.json");
        // One outstanding slot. Never acknowledge a request that overwrites another.
        static std::mutex command_mutex;
        std::lock_guard<std::mutex> lock(command_mutex);
        auto pending = read_text(cmd);
        pending.erase(std::remove_if(pending.begin(), pending.end(), [](unsigned char c) {
            return c == ' ' || c == '\t' || c == '\r' || c == '\n';
        }), pending.end());
        if (!pending.empty() && pending != "{}" && pending != "null") {
            res.status = 409;
            res.set_content("{\"ok\":false,\"error\":\"another command is awaiting game acknowledgement\"}", "application/json");
            return;
        }
        if (!atomic_write_text(cmd, req.body)) {
            res.status = 500;
            res.set_content("{\"ok\":false,\"error\":\"failed to write command slot\"}", "application/json");
            return;
        }
        std::ostringstream ss;
        ss << "{\"ok\":true,\"queued\":true,\"bytes\":" << req.body.size() << "}";
        res.set_content(ss.str(), "application/json");
    });

    // Vue 单 HTML 控制台：与 API 同源（console.html 随 webconsole.dll 部署到 plugins/）。
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
