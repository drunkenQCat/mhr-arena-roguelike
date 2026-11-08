#pragma once
#include "common.h"

namespace webconsole {

enum class RecoveryWriteStage { Created, Written, Flushed, Published };
using RecoveryWriteObserver = bool (*)(RecoveryWriteStage);

// Only recovery journals, never a caller-controlled path. The observer is a
// native test seam for interrupted writes; it is not exposed to Lua or HTTP.
inline bool write_recovery(const std::string& name, const std::string& body,
                           RecoveryWriteObserver observer = nullptr) noexcept {
    if ((name != "mhw_rogue_startup_state.json" && name != "mhw_rogue_pouch_state.json") ||
        body.empty() || body.size() > 2 * 1024 * 1024 || g_data_dir.empty()) return false;
    static std::mutex mutex;
    static std::atomic<unsigned long long> sequence{0};
    HANDLE handle = INVALID_HANDLE_VALUE;
    std::wstring temporary;
    try {
        std::lock_guard lock(mutex);
        const auto path = data_path(std::wstring(name.begin(), name.end()).c_str());
        temporary = path + L".tmp-" + std::to_wstring(GetCurrentProcessId()) +
                    L"-" + std::to_wstring(++sequence);
        handle = CreateFileW(temporary.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW,
                             FILE_ATTRIBUTE_NORMAL | FILE_FLAG_WRITE_THROUGH, nullptr);
        if (handle == INVALID_HANDLE_VALUE) return false;
        bool ok = !observer || observer(RecoveryWriteStage::Created);
        size_t offset = 0;
        while (ok && offset < body.size()) {
            DWORD written = 0;
            ok = WriteFile(handle, body.data() + offset,
                           static_cast<DWORD>(body.size() - offset), &written, nullptr) && written > 0;
            offset += written;
        }
        if (ok && observer) ok = observer(RecoveryWriteStage::Written);
        if (ok) ok = FlushFileBuffers(handle) != FALSE;
        if (ok && observer) ok = observer(RecoveryWriteStage::Flushed);
        const bool closed = CloseHandle(handle) != FALSE;
        handle = INVALID_HANDLE_VALUE;
        ok = ok && closed;
        if (ok) ok = MoveFileExW(temporary.c_str(), path.c_str(),
                                 MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH) != FALSE;
        if (!ok) { DeleteFileW(temporary.c_str()); return false; }
        if (observer) observer(RecoveryWriteStage::Published);
        return true;
    } catch (...) {
        if (handle != INVALID_HANDLE_VALUE) CloseHandle(handle);
        if (!temporary.empty()) DeleteFileW(temporary.c_str());
        return false;
    }
}

} // namespace webconsole
