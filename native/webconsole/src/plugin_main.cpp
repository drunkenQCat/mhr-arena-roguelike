// REFramework 原生插件入口：初始化目录、启动 HTTP 线程、记录模块目录。
// 业务操作（游戏对象读写）不在这里——全部由 Lua 控制层经文件信箱执行。
#include "common.h"
#include "http_server.h"

#include <filesystem>

#ifndef WEBCONSOLE_STANDALONE

extern "C" __declspec(dllexport) void reframework_plugin_required_version(REFrameworkPluginVersion* version) {
    version->major = REFRAMEWORK_PLUGIN_VERSION_MAJOR;
    version->minor = REFRAMEWORK_PLUGIN_VERSION_MINOR;
    version->patch = REFRAMEWORK_PLUGIN_VERSION_PATCH;
}

extern "C" __declspec(dllexport) bool reframework_plugin_initialize(const REFrameworkPluginInitializeParam* param) {
    if (!param || !param->functions) return false;
    log_sink = param->functions->log_info;

    // 数据目录 = <game>/reframework/data（与 json.dump_file 的落点一致）
    char exe_dir[MAX_PATH] = {};
    GetModuleFileNameA(nullptr, exe_dir, MAX_PATH);
    std::string root = exe_dir;
    const auto slash = root.find_last_of('\\');
    if (slash != std::string::npos) root = root.substr(0, slash);
    g_data_dir = std::wstring(root.begin(), root.end()) + L"\\reframework\\data";
    std::filesystem::create_directories(g_data_dir);

    start_http_server();
    log_info("initialized; http thread starting");
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
        // 插件常驻进程生命周期；不做运行时卸载
    }
    return TRUE;
}

#else

// 独立测试进程：不依赖游戏/REFramework，可复现全部端点行为。
// 用法：webconsole_test.exe [端口]
int main(int argc, char** argv)
{
    if (argc > 1) g_listen_port = static_cast<unsigned short>(std::stoi(argv[1]));
    wchar_t buf[MAX_PATH] = {};
    GetModuleFileNameW(nullptr, buf, MAX_PATH);
    std::wstring full = buf;
    const auto sl = full.find_last_of(L'\\');
    g_module_dir = full.substr(0, sl);
    g_data_dir = g_module_dir + L"\\testdata";
    _wmkdir((g_module_dir + L"\\testdata").c_str());
    log_info("standalone webconsole (test mode)");
    start_http_server();
    // 阻塞主线程保持服务运行
    for (;;) std::this_thread::sleep_for(std::chrono::seconds(60));
    return 0;
}

#endif
