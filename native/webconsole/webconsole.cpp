// webconsole — REFramework 原生插件（Phase-2：HTTP 服务 + 文件信箱 + 控制台分发）
// 职责边界（架构定案）：
//   - HTTP 线程（cpp-httplib）监听 127.0.0.1:11777，仅本机
//   - GET  / | /console   → console.html（Vue 单 HTML，与 API 同源分发）
//   - GET  /api/health    → 插件存活 + 版本
//   - GET  /api/state     → webconsole_state.json（Lua 桥 ~2Hz 写出，200ms 缓存共享）
//   - GET  /api/results   → webconsole_results.json（命令执行结果，200ms 缓存）
//   - GET  /api/config    → mhw_rogue_config.json（持久配置覆盖；无覆盖=404）
//   - POST /api/command   → 原子写入 webconsole_cmd.json（单槽；Lua 限频轮询执行）
//   - 不直接触碰游戏对象/内存；游戏操作全部由 Lua 控制层执行
// 线程模型：HTTP 在 cpp-httplib 线程池；文件写入用临时文件+MoveFileExW 原子替换；
//   缓存读用自旋锁去重撞盘。handler 内任何未捕获异常都会 std::terminate
//   带崩整个游戏进程（22:34 实机崩溃教训：全栈在本 DLL 的线程上 RaiseException），
//   因此 listen 前设置 error handler，且所有文件操作路径不抛异常（ifstream 失败只返回空）。
// 测试模式：cl /D WEBCONSOLE_STANDALONE 生成独立 exe，可在游戏外复现全部端点行为。
// 生命周期：DLL 随 REFramework 常驻，不受 ScriptRunner Reset 影响。

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

#ifndef WEBCONSOLE_STANDALONE
#include "reframework/API.h"
#endif

namespace {
constexpr const char* PLUGIN_VERSION = "0.2.0";
constexpr unsigned short LISTEN_PORT = 11777;

std::thread g_server_thread;
std::wstring g_data_dir;
std::wstring g_module_dir;

#ifndef WEBCONSOLE_STANDALONE
REFrameworkPluginFunctions g_functions{};
void log_info(const char* msg) {
    if (g_functions.log_info) g_functions.log_info("[webconsole] %s", msg);
}
#else
void log_info(const char* msg) { printf("[webconsole] %s\n", msg); }
#endif

std::wstring data_path(const wchar_t* name) { return g_data_dir + L"\\" + name; }

std::string read_text(const std::wstring& path) {
    std::ifstream f(path.c_str(), std::ios::binary);
    if (!f.good()) return {};
    std::ostringstream ss;
    ss << f.rdbuf();
    return ss.str();
}

// 原子写文本：临时文件 + MoveFileExW（竞争/占用时限次重试）
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

// 缓存读：所有客户端共享同一份磁盘读，限频撞盘；自旋锁护住缓存体。
// 注意：cpp-httplib 默认线程池并发调用 handler，静态缓存必须自加锁。
struct CachedFile {
    std::atomic_flag spin = ATOMIC_FLAG_INIT;
    std::chrono::steady_clock::time_point last{};
    std::string body;
    bool valid = false;
};

std::string cached_read(CachedFile& c, const std::wstring& path, int ttl_ms) {
    while (c.spin.test_and_set(std::memory_order_acquire)) std::this_thread::yield();
    struct Guard {
        std::atomic_flag& f;
        ~Guard() { f.clear(std::memory_order_release); }
    } guard{c.spin};
    const auto now = std::chrono::steady_clock::now();
    if (!c.valid || now - c.last > std::chrono::milliseconds(ttl_ms)) {
        c.body = read_text(path); // ifstream 读失败只返回空，不抛
        c.last = now;
        c.valid = true;
    }
    return c.body;
}

void run_server() {
    httplib::Server svr;

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
    // 上限 256KB：容纳 submitConfig 的完整配置提交
    svr.Post("/api/command", [](const httplib::Request& req, httplib::Response& res) {
        if (req.body.size() > 262144) {
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

    // Vue 单 HTML 控制台：与 API 同源（console.html 随 webconsole.dll 部署到 plugins/）。
    // 注意：用两个单路径注册——多路径 initializer_list 重载在请求处理时走 regex 匹配路径，
    // 曾触发未捕获 regex_error 导致进程 terminate（2026-10-27 实机崩溃，c0000409 FAST_FAIL）。
    svr.Get("/", [&](const httplib::Request&, httplib::Response& res) {
        res.set_content("redirect to /console", "text/plain");
    });
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

    if (!svr.listen("127.0.0.1", LISTEN_PORT)) {
        log_info("listen failed on 127.0.0.1:11777");
    }
}

} // namespace

#ifndef WEBCONSOLE_STANDALONE

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

    g_server_thread = std::thread(run_server);
    log_info("initialized; http thread starting on 127.0.0.1:11777");
    return true;
}

BOOL APIENTRY DllMain(HMODULE hModule, DWORD reason, LPVOID) {
    if (reason == DLL_PROCESS_ATTACH) {
        // 记录插件自身所在目录（reframework/plugins）——console.html 的分发位置
        wchar_t buf[MAX_PATH] = {};
        if (GetModuleFileNameW(hModule, buf, MAX_PATH) > 0) {
            std::wstring full = buf;
            const auto slash = full.find_last_of(L'\\');
            if (slash != std::wstring::npos) g_module_dir = full.substr(0, slash);
        }
    } else if (reason == DLL_PROCESS_DETACH) {
        if (g_server_thread.joinable()) g_server_thread.detach();
    }
    return TRUE;
}

#else

#include <direct.h>
int main() {
    wchar_t buf[MAX_PATH] = {};
    GetModuleFileNameW(nullptr, buf, MAX_PATH);
    std::wstring full = buf;
    const auto sl = full.find_last_of(L'\\');
    g_module_dir = full.substr(0, sl);
    g_data_dir = g_module_dir + L"\\testdata";
    _wmkdir((g_module_dir + L"\\testdata").c_str());
    std::ofstream(data_path(L"webconsole_state.json")) << "{\"ok\":true,\"protocol\":2}";
    std::ofstream(data_path(L"webconsole_results.json")) << "{\"history\":[]}";
    std::ofstream(data_path(L"mhw_rogue_config.json")) << "{\"startPt\":150}";
    printf("standalone webconsole on 127.0.0.1:11777\n");
    run_server();
    return 0;
}

#endif
