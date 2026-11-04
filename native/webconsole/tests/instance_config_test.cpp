#include "common.h"
#include <filesystem>
#include <stdexcept>
using namespace webconsole;
void check(bool v, const char* why) { if (!v) throw std::runtime_error(why); }
int main() {
    auto dir = std::filesystem::temp_directory_path() / (L"mhr-instance-" + std::to_wstring(GetCurrentProcessId()));
    std::filesystem::create_directories(dir); g_module_dir = dir.wstring();
    SetEnvironmentVariableW(L"MHR_WEBCONSOLE_PORT", nullptr);
    SetEnvironmentVariableW(L"MHR_WEBCONSOLE_OPEN_BROWSER", nullptr);
    check(configure_instance() && g_listen_port == 11777 && g_open_browser, "default instance config");
    const auto ini = dir / "webconsole.ini";
    WritePrivateProfileStringW(L"webconsole", L"port", L"11778", ini.c_str());
    WritePrivateProfileStringW(L"webconsole", L"openBrowser", L"0", ini.c_str());
    check(configure_instance() && g_listen_port == 11778 && !g_open_browser, "INI instance isolation");
    SetEnvironmentVariableW(L"MHR_WEBCONSOLE_PORT", L"11779");
    SetEnvironmentVariableW(L"MHR_WEBCONSOLE_OPEN_BROWSER", L"1");
    check(configure_instance() && g_listen_port == 11779 && g_open_browser, "environment precedence");
    for (auto invalid : {L"0", L"65536", L"-1", L"11778oops", L"99999999999999999999999999999999999999"}) {
        SetEnvironmentVariableW(L"MHR_WEBCONSOLE_PORT", invalid);
        check(!configure_instance() && g_listen_port == 11779, "invalid port changed instance");
    }
    SetEnvironmentVariableW(L"MHR_WEBCONSOLE_PORT", nullptr);
    SetEnvironmentVariableW(L"MHR_WEBCONSOLE_OPEN_BROWSER", nullptr);
    std::filesystem::remove(ini); std::filesystem::remove(dir);
}
