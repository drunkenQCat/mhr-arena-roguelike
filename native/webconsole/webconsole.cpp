// webconsole — REFramework 原生插件（Phase 1 通信验证）
// 职责边界（架构定案）：
//   - HTTP 线程（cpp-httplib）监听 127.0.0.1:11777，仅本机
//   - GET  /            → 内置控制台占位页
//   - GET  /api/health  → 插件存活 + 版本
//   - GET  /api/state   → 读数据目录 webconsole_state.json（Lua 侧写出，缓存 200ms）
//   - POST /api/command → 原子写入 webconsole_cmd.json（Lua 侧限频轮询执行，结果回写 webconsole_result.json）
//   - 不直接触碰游戏对象/内存；游戏操作全部由 Lua 控制层执行（简报 §1 边界）
// 线程模型：HTTP 在 cpp-httplib 的线程池；文件写入用临时文件+ReplaceFileW 原子替换；
//           命令槽为单槽覆盖式（天然串行化，前端节流防堆积）。
// 生命周期：DLL 随 REFramework 常驻，不受 ScriptRunner Reset 影响；Lua 侧重置时清空命令槽
//           （通过 Lua 写空 cmd 槽实现，插件无感知）。

#include <winsock2.h>
#include <ws2tcpip.h>
#include <Windows.h>

#include <atomic>
#include <chrono>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>
#include <thread>

#include "httplib.h"
#include "reframework/API.h"

namespace {
constexpr const char* PLUGIN_VERSION = "0.1.0";
constexpr unsigned short LISTEN_PORT = 11777;

std::atomic<bool> g_running{false};
std::thread g_server_thread;
REFrameworkPluginFunctions g_functions{};
std::wstring g_data_dir;

std::wstring data_path(const wchar_t* name) { return g_data_dir + L"\\" + name; }

// 原子写文本：临时文件 + ReplaceFileW（目标被占用时限次重试）
bool atomic_write_text(const std::wstring& path, const std::string& text) {
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

std::string read_text(const std::wstring& path) {
    std::ifstream f(path.c_str(), std::ios::binary);
    if (!f.good()) return {};
    std::ostringstream ss;
    ss << f.rdbuf();
    return ss.str();
}

void log_info(const char* msg) {
    if (g_functions.log_info) g_functions.log_info("[webconsole] %s", msg);
}

// ---- HTTP handlers（cpp-httplib 线程池上下文）----

std::string health_body() {
    std::ostringstream ss;
    ss << "{\"ok\":true,\"plugin\":\"webconsole\",\"version\":\"" << PLUGIN_VERSION << "\"}";
    return ss.str();
}

void run_server() {
    httplib::Server svr;

    svr.set_default_headers({{"Access-Control-Allow-Origin", "http://127.0.0.1:11777"},
                             {"Access-Control-Allow-Methods", "GET, POST, OPTIONS"},
                             {"Access-Control-Allow-Headers", "Content-Type"}});

    svr.Get("/api/health", [](const httplib::Request&, httplib::Response& res) {
        res.set_content(health_body(), "application/json");
    });

    // Lua 侧每 200ms 写一次 webconsole_state.json；插件缓存 200ms 避免每请求撞盘
    svr.Get("/api/state", [&](const httplib::Request&, httplib::Response& res) {
        static std::chrono::steady_clock::time_point last{};
        static std::string cached;
        static std::atomic<bool> valid{false};
        const auto now = std::chrono::steady_clock::now();
        if (!valid.load() || now - last > std::chrono::milliseconds(200)) {
            cached = read_text(data_path(L"webconsole_state.json"));
            last = now;
            valid.store(true);
        }
        if (cached.empty()) {
            res.status = 503;
            res.set_content("{\"ok\":false,\"error\":\"state file not written yet\"}", "application/json");
        } else {
            res.set_content(cached, "application/json");
        }
    });

    // 单命令槽：POST 覆盖式写入；Lua 执行后写 webconsole_result.json 并清空槽
    svr.Post("/api/command", [](const httplib::Request& req, httplib::Response& res) {
        if (req.body.size() > 4096) {
            res.status = 413;
            res.set_content("{\"ok\":false,\"error\":\"command too large\"}", "application/json");
            return;
        }
        const std::wstring cmd = data_path(L"webconsole_cmd.json");
        if (!atomic_write_text(cmd, req.body)) {
            res.status = 500;
            res.set_content("{\"ok\":false,\"error\":\"failed to write command slot\"}", "application/json");
            return;
        }
        std::ostringstream ss;
        ss << "{\"ok\":true,\"queued\":true,\"bytes\":" << req.body.size() << "}";
        res.set_content(ss.str(), "application/json");
    });

    svr.Get("/", [](const httplib::Request&, httplib::Response& res) {
        res.set_content(
            "<!doctype html><meta charset='utf-8'><title>MHR webconsole</title>"
            "<p>webconsole phase-1 placeholder. API: /api/health /api/state (GET), /api/command (POST).</p>",
            "text/html; charset=utf-8");
    });

    if (!svr.listen("127.0.0.1", LISTEN_PORT)) {
        log_info("listen failed on 127.0.0.1:11777");
        return;
    }
}

} // namespace

extern "C" __declspec(dllexport) void reframework_plugin_required_version(REFrameworkPluginVersion* version) {
    version->major = REFRAMEWORK_PLUGIN_VERSION_MAJOR;
    version->minor = REFRAMEWORK_PLUGIN_VERSION_MINOR;
    version->patch = REFRAMEWORK_PLUGIN_VERSION_PATCH;
}

extern "C" __declspec(dllexport) bool reframework_plugin_initialize(const REFrameworkPluginInitializeParam* param) {
    if (!param || !param->functions) return false;
    g_functions = *param->functions;

    // 数据目录 = <game>/reframework/data（与 json.dump_file 的落点一致）
    char exe_dir[MAX_PATH] = {};
    GetModuleFileNameA(nullptr, exe_dir, MAX_PATH);
    std::string root = exe_dir;
    const auto slash = root.find_last_of('\\');
    if (slash != std::string::npos) root = root.substr(0, slash);
    g_data_dir = std::wstring(root.begin(), root.end()) + L"\\reframework\\data";
    std::filesystem::create_directories(g_data_dir);

    g_running = true;
    g_server_thread = std::thread(run_server);
    log_info("initialized; http thread starting on 127.0.0.1:11777");
    return true;
}

BOOL APIENTRY DllMain(HMODULE, DWORD reason, LPVOID) {
    if (reason == DLL_PROCESS_DETACH) {
        g_running = false;
        if (g_server_thread.joinable()) {
            // cpp-httplib: svr 停止需要对象作用域；进程卸载时线程随进程结束
            // Phase-1 接受：插件常驻进程生命周期，不提供运行时卸载
        }
    }
    return TRUE;
}
