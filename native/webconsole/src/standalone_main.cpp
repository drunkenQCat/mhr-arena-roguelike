// Standalone test process: no game and no REFramework, reproduces every endpoint.
// Usage: webconsole_test.exe [port]
#include "common.h"
#include "http_server.h"

#include <direct.h>

int main(int argc, char** argv)
{
    if (argc > 1) webconsole::g_listen_port = static_cast<unsigned short>(std::stoi(argv[1]));
    wchar_t buf[MAX_PATH] = {};
    GetModuleFileNameW(nullptr, buf, MAX_PATH);
    std::wstring full = buf;
    const auto slash = full.find_last_of(L"\\");
    webconsole::g_module_dir = slash == std::wstring::npos ? full : full.substr(0, slash);
    webconsole::g_data_dir = webconsole::g_module_dir + L"\\testdata";
    webconsole::g_game_root = webconsole::g_module_dir;
    _wmkdir(webconsole::g_data_dir.c_str());
    webconsole::init_session_id();
    webconsole::log_info("standalone webconsole (test mode)");
    webconsole::start_http_server();
    // Block the main thread so the server keeps running.
    for (;;) std::this_thread::sleep_for(std::chrono::seconds(60));
    return 0;
}
