// webconsole 共享定义：版本、目录、日志、文件工具与缓存读。
// 被 http_server.cpp（端点）与 plugin_main.cpp / standalone_main.cpp（入口）共用。
// 线程模型：HTTP 在 cpp-httplib 线程池；文件写入用临时文件+MoveFileExW 原子替换；
//   缓存读用自旋锁去重撞盘。handler 内任何未捕获异常都会 std::terminate
//   带崩整个游戏进程（实机教训：全栈在本 DLL 的线程上 RaiseException），
//   因此所有文件操作路径不抛异常（ifstream 失败只返回空）。
#pragma once

// winsock2.h 必须先于 Windows.h（否则 winsock.h 旧版被拉入导致 sockaddr 重定义）
#include <winsock2.h>
#include <ws2tcpip.h>
#include <Windows.h>

#include <atomic>
#include <chrono>
#include <deque>
#include <fstream>
#include <mutex>
#include <sstream>
#include <string>
#include <thread>

namespace webconsole {

inline constexpr const char* PLUGIN_VERSION = "0.3.1";
inline unsigned short g_listen_port = 11777;

// 日志汇点：插件入口指向 REFramework log，standalone 测试指向 printf。
// 空汇点 = 静默（进程退出前的日志本就不保证可见）。
inline void (*log_sink)(const char*) = nullptr;
inline void log_info(const char* msg) { if (log_sink) log_sink(msg); }

// 数据目录 = <game>/reframework/data；模块目录 = reframework/plugins（console.html 所在）。
// 由入口（DllMain / standalone main）设置一次，进程内只读。
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

// 原子写文本：临时文件 + MoveFileExW（竞争/占用时限次重试）
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

// 缓存读：所有客户端共享同一份磁盘读，限频撞盘；自旋锁护住缓存体。
// 注意：cpp-httplib 默认线程池并发调用 handler，静态缓存必须自加锁。
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
        c.body = read_text(path); // ifstream 读失败只返回空，不抛
        c.last = now;
        c.valid = true;
    }
    return c.body;
}

} // namespace webconsole
