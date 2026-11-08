#include "recovery_file.h"
#include <filesystem>
#include <iostream>
#include <stdexcept>
#include <vector>

namespace fs = std::filesystem;
static int crash_stage = -1;
static bool interrupt_at(webconsole::RecoveryWriteStage stage) {
    if (static_cast<int>(stage) == crash_stage) TerminateProcess(GetCurrentProcess(), 77);
    return true;
}
static bool refuse_flush(webconsole::RecoveryWriteStage stage) {
    return stage != webconsole::RecoveryWriteStage::Written;
}
static void check(bool ok, const char* message) { if (!ok) throw std::runtime_error(message); }
static const std::string name = "mhw_rogue_startup_state.json";
static const std::string original = "{\"active\":true,\"generation\":1}";
static const std::string replacement = "{\"active\":false,\"payload\":\"" + std::string(131072, 'x') + "\"}";

int wmain(int argc, wchar_t** argv) try {
    if (argc == 4 && std::wstring(argv[1]) == L"--crash") {
        crash_stage = std::stoi(argv[2]);
        webconsole::g_data_dir = argv[3];
        webconsole::write_recovery(name, replacement, interrupt_at);
        return 1;
    }
    const auto directory = fs::temp_directory_path() / (L"mhr-recovery-test-" + std::to_wstring(GetCurrentProcessId()));
    check(fs::create_directory(directory), "test directory already exists");
    webconsole::g_data_dir = directory.wstring();
    const auto path = webconsole::data_path(L"mhw_rogue_startup_state.json");
    check(webconsole::write_recovery(name, original), "first write failed");
    check(!webconsole::write_recovery("../escape.json", replacement), "path traversal accepted");
    check(!webconsole::write_recovery(name + std::string("\0suffix", 7), replacement), "embedded NUL accepted");
    check(!webconsole::write_recovery(name, ""), "empty body accepted");
    check(!webconsole::write_recovery(name, std::string(2097153, 'x')), "oversize body accepted");
    check(webconsole::read_text(path) == original, "invalid input changed original");

    auto locked = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, 0, nullptr);
    check(locked != INVALID_HANDLE_VALUE, "cannot lock target");
    const bool replaced_locked = webconsole::write_recovery(name, replacement);
    CloseHandle(locked);
    check(!replaced_locked && webconsole::read_text(path) == original, "failed rename damaged original");
    check(!webconsole::write_recovery(name, replacement, refuse_flush), "interrupted write was accepted");
    check(webconsole::read_text(path) == original, "interrupted write damaged original");

    wchar_t executable[32768]{};
    check(GetModuleFileNameW(nullptr, executable, 32768) != 0, "cannot resolve test executable");
    for (int stage = 0; stage <= 3; ++stage) {
        check(webconsole::write_recovery(name, original), "cannot reset crash fixture");
        auto command = L"\"" + std::wstring(executable) + L"\" --crash " + std::to_wstring(stage) +
                       L" \"" + directory.wstring() + L"\"";
        STARTUPINFOW startup{}; startup.cb = sizeof(startup);
        PROCESS_INFORMATION child{};
        check(CreateProcessW(executable, command.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW,
                             nullptr, nullptr, &startup, &child) != FALSE, "cannot start crash child");
        const auto wait = WaitForSingleObject(child.hProcess, 10000);
        if (wait != WAIT_OBJECT_0) TerminateProcess(child.hProcess, 78);
        DWORD exit = 0; GetExitCodeProcess(child.hProcess, &exit);
        CloseHandle(child.hThread); CloseHandle(child.hProcess);
        check(wait == WAIT_OBJECT_0 && exit == 77, "child did not interrupt at requested stage");
        check(webconsole::read_text(path) == (stage == 3 ? replacement : original), "crash exposed partial journal");
    }
    std::vector<std::thread> writers;
    std::atomic<int> successes{0};
    for (int i = 0; i < 8; ++i) writers.emplace_back([&, i] {
        if (webconsole::write_recovery(name, std::string(65536, static_cast<char>('a' + i)))) ++successes;
    });
    for (auto& writer : writers) writer.join();
    const auto contents = webconsole::read_text(path);
    check(successes == 8 && contents.size() == 65536 && contents == std::string(65536, contents.front()),
          "concurrent writers mixed payloads");
    // Only this test's newly created directory is removed, including abandoned
    // temporary files from the deliberately terminated child processes.
    fs::remove_all(directory);
    std::cout << "PASS: restricted journal paths, failed publication, four process crash stages, concurrent writes\n";
    return 0;
} catch (const std::exception& error) {
    std::cerr << error.what() << '\n'; return 1;
}
