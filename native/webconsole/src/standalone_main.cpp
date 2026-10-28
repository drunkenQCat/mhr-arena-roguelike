// 独立测试进程：不依赖游戏/REFramework，可复现全部端点行为。
// 用法：webconsole_test.exe [端口]
#include "common.h"
#include "http_server.h"

#include <direct.h>

int main(int argc, char** argv)
{
    if (argc > 1) webconsole::g_listen_port = static_cast<unsigned short>(std::stoi(argv[1]));
    wchar_t buf[MAX_PATH] = {};
    GetModuleFileNameW(nullptr, buf, MAX_PATH);
    std::wstring full = buf;
    const auto sl = full.find_last_of(L'\');
    webconsole::g_module_dir = full.substr(0, sl);
    webconsole::g_data_dir = webconsole::g_module_dir + L"\testdata";
    _wmkdir(webconsole::g_data_dir.c_str());
    webconsole::log_info("standalone webconsole (test mode)");
    webconsole::start_http_server();
    // 阻塞主线程保持服务运行
    for (;;) std::this_thread::sleep_for(std::chrono::seconds(60));
    return 0;
}
