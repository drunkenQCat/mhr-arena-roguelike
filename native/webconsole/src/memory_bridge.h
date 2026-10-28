// Memory bridge queue: bounded command/state exchange between HTTP threads and the
// Lua control layer.
// Thread discipline:
//   - HTTP threads only push plain strings; the lock only moves data, never runs game
//     calls or JSON parsing.
//   - Lua (game callbacks) pops and clears under the same lock; never take another
//     lock while holding this one.
// Bounds: 64 commands / 1 MiB total; a full queue rejects the push (HTTP 429) and
// never overwrites an already accepted request.
// Lifetime: process-wide singleton that outlives ScriptRunner Reset; the first
// begin_session(epoch) from a fresh Lua state starts the new generation and drops
// stale commands.
#pragma once

#include <atomic>
#include <deque>
#include <mutex>
#include <string>

namespace webconsole {

class MemoryBridge
{
public:
    static constexpr size_t MAX_COMMANDS = 64;
    static constexpr size_t MAX_COMMAND_BYTES = 1 << 20; // per-command cap inside the total budget
    static constexpr size_t MAX_TOTAL_BYTES = 1 << 20;   // whole-queue budget

    // HTTP threads: enqueue. Returns false when full/over budget (caller answers 429).
    bool push_command(std::string json)
    {
        std::lock_guard<std::mutex> lock(mutex_);
        if (commands_.size() >= MAX_COMMANDS || total_bytes_ + json.size() > MAX_TOTAL_BYTES) return false;
        total_bytes_ += json.size();
        commands_.push_back(std::move(json));
        return true;
    }

    // Lua callback: pop one command (false = empty). Avoids re-parsing a JSON array text.
    bool pop_command(std::string& out)
    {
        std::lock_guard<std::mutex> lock(mutex_);
        if (commands_.empty()) return false;
        out = std::move(commands_.front());
        total_bytes_ -= out.size();
        commands_.pop_front();
        return true;
    }

    // Lua callback: publish the state snapshot (overwrite; HTTP reads the same text).
    void publish_state(std::string json)
    {
        std::lock_guard<std::mutex> lock(mutex_);
        state_ = std::move(json);
        state_seq_.fetch_add(1, std::memory_order_relaxed);
    }

    std::string state_snapshot()
    {
        std::lock_guard<std::mutex> lock(mutex_);
        return state_;
    }

    // Lua callback: publish the result table (bounded; Lua truncates before publishing).
    void publish_results(std::string json)
    {
        std::lock_guard<std::mutex> lock(mutex_);
        results_ = std::move(json);
    }

    std::string results_snapshot()
    {
        std::lock_guard<std::mutex> lock(mutex_);
        return results_;
    }

    // Lua callback: publish the module probe report (overwrite; the console renders it).
    void publish_probe(std::string json)
    {
        std::lock_guard<std::mutex> lock(mutex_);
        probe_ = std::move(json);
    }

    std::string probe_snapshot()
    {
        std::lock_guard<std::mutex> lock(mutex_);
        return probe_;
    }

    // Lua callback: new generation (fired by the Lua bridge after Reset scripts).
    // Queued commands that never executed belong to the old generation and are dropped.
    void begin_session(unsigned long long epoch)
    {
        std::lock_guard<std::mutex> lock(mutex_);
        commands_.clear();
        total_bytes_ = 0;
        epoch_ = epoch;
    }

    unsigned long long epoch()
    {
        std::lock_guard<std::mutex> lock(mutex_);
        return epoch_;
    }

    size_t queued_commands()
    {
        std::lock_guard<std::mutex> lock(mutex_);
        return commands_.size();
    }

    // Monotonic count of published state snapshots; 0 means Lua never published.
    unsigned long long state_sequence() const { return state_seq_.load(std::memory_order_relaxed); }

private:
    std::mutex mutex_;
    std::deque<std::string> commands_;
    size_t total_bytes_ = 0;
    std::string state_;
    std::string results_;
    std::string probe_;
    unsigned long long epoch_ = 0;
    std::atomic<unsigned long long> state_seq_{0};
};

// Process-wide singleton: the plugin DLL and the standalone test exe each own one copy,
// shared between HTTP handlers and the Lua module functions. Defined in http_server.cpp.
MemoryBridge& bridge();

} // namespace webconsole