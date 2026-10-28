// 内存桥队列：HTTP 线程与 Lua 控制层之间的有界命令/状态交换。
// 线程纪律（简报 §一/§二）：
//   - HTTP 线程只 push 纯字符串；锁内只移动数据，不执行游戏调用或 JSON 解析。
//   - Lua（游戏回调）take 时搬运并清空；不持有本锁再获取其他锁。
// 有界性：命令 64 条 / 合计 1 MiB；满时 push 拒绝（HTTP 429），绝不覆盖已接收请求。
// 生命周期：进程级单例，跨 ScriptRunner Reset 存活；Lua 侧重置后第一次
//   begin_session(epoch) 视为新代（旧命令清除，由 Lua 侧触发）。
#pragma once

#include <deque>
#include <mutex>
#include <string>

namespace webconsole {

class MemoryBridge
{
public:
    static constexpr size_t MAX_COMMANDS = 64;
    static constexpr size_t MAX_COMMAND_BYTES = 1 << 20; // 1 MiB 合计预算内的单条上限
    static constexpr size_t MAX_TOTAL_BYTES = 1 << 20;   // 1 MiB 队列合计预算

    // HTTP 线程：入队。满/超预算返回 false（调用方回 429）。
    bool push_command(std::string json)
    {
        std::lock_guard<std::mutex> lock(mutex_);
        if (commands_.size() >= MAX_COMMANDS || total_bytes_ + json.size() > MAX_TOTAL_BYTES) return false;
        total_bytes_ += json.size();
        commands_.push_back(std::move(json));
        return true;
    }

    // Lua 回调：取走至多 maxCount 条（返回 JSON 数组文本，如 ["{...}","{...}"]）。
    std::string take_commands(size_t maxCount)
    {
        std::lock_guard<std::mutex> lock(mutex_);
        std::string out = "[";
        bool first = true;
        while (!commands_.empty() && maxCount > 0) {
            if (!first) out += ",";
            out += commands_.front();
            total_bytes_ -= commands_.front().size();
            commands_.pop_front();
            --maxCount;
            first = false;
        }
        out += "]";
        return out;
    }

    // Lua 回调：逐条弹出（返回 false = 队列空）。避免 JSON 数组文本的二次解析。
    bool pop_command(std::string& out)
    {
        std::lock_guard<std::mutex> lock(mutex_);
        if (commands_.empty()) return false;
        out = std::move(commands_.front());
        total_bytes_ -= out.size();
        commands_.pop_front();
        return true;
    }

    // Lua 回调：发布状态快照（覆盖式；HTTP 侧读走同一文本）。
    void publish_state(std::string json) { publish_state_.assign(std::move(json)); }

    std::string state_snapshot()
    {
        std::lock_guard<std::mutex> lock(mutex_);
        return state_;
    }

    // Lua 回调：结果表覆盖（有界——超长截断由 Lua 侧先做）。
    void publish_results(std::string json) { publish_results_.assign(std::move(json)); }

    std::string results_snapshot()
    {
        std::lock_guard<std::mutex> lock(mutex_);
        return results_;
    }

    // Lua 回调：新代会话（Reset scripts 后由 Lua 桥触发）——清空未执行命令。
    // 已进槽未执行的命令按任务书语义作废（旧代），HTTP 侧下次 take 为空。
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

private:
    std::mutex mutex_;
    std::deque<std::string> commands_;
    size_t total_bytes_ = 0;
    std::string state_;
    std::string results_;
    unsigned long long epoch_ = 0;
};

} // namespace webconsole
