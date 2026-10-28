// Lua C 模块入口：luaopen_webconsole
// 由宿主 Lua 通过 package.cpath 加载（webconsole.dll 同时是 REFramework 插件与 Lua C 模块）。
// 模块内使用本 DLL 静态编译的 Lua 5.4.3 实现（与 REFramework dependencies/lua 同源同版本），
// 操作宿主传入的 lua_State——同源码编译保证布局一致（Lua 官方 C 库模式）。
//
// 注册的内存桥函数（底层为 webconsole::g_memory_bridge，HTTP 线程与 Lua 在锁两侧）：
//   webconsole.ping(s)                -> s          连通性验证（原样返回）
//   webconsole.take_commands(max)     -> table      取走待执行命令（字符串数组，逐条 JSON 文本）
//   webconsole.publish_state(json)    -> void       发布状态快照
//   webconsole.publish_results(json)  -> void       发布结果表
//   webconsole.begin_session(epoch)   -> epoch      新代会话（清未执行命令）
//   webconsole.epoch()                -> n          当前代
//   webconsole.gc()                   -> void       collectgarbage("collect") 透传（验收项）

#include "common.h"
#include "memory_bridge.h"

#include <lua.hpp>

#include <mutex>

namespace {

webconsole::MemoryBridge g_bridge;
std::mutex g_bridge_mutex; // Lua 单线程调用；与 HTTP 侧各持 MemoryBridge 内部锁，不嵌套

int lua_ping(lua_State* L)
{
    size_t len = 0;
    const char* s = luaL_checklstring(L, 1, &len);
    lua_pushlstring(L, s, len);
    return 1;
}

int lua_take_commands(lua_State* L)
{
    const lua_Integer max = luaL_optinteger(L, 1, 8);
    lua_newtable(L);
    lua_Integer index = 1;
    std::string out;
    while (index <= max && g_bridge.pop_command(out)) {
        lua_pushlstring(L, out.data(), out.size());
        lua_rawseti(L, -2, static_cast<lua_Integer>(index));
        ++index;
    }
    return 1;
}

int lua_publish_state(lua_State* L)
{
    size_t len = 0;
    const char* s = luaL_checklstring(L, 1, &len);
    g_bridge.publish_state(std::string(s, len));
    return 0;
}

int lua_publish_results(lua_State* L)
{
    size_t len = 0;
    const char* s = luaL_checklstring(L, 1, &len);
    g_bridge.publish_results(std::string(s, len));
    return 0;
}

int lua_begin_session(lua_State* L)
{
    const lua_Integer epoch = luaL_checkinteger(L, 1);
    g_bridge.begin_session(static_cast<unsigned long long>(epoch));
    lua_pushinteger(L, epoch);
    return 1;
}

int lua_epoch(lua_State* L)
{
    lua_pushinteger(L, static_cast<lua_Integer>(g_bridge.epoch()));
    return 1;
}

int lua_gc(lua_State* L)
{
    lua_gc(L, LUA_GCCOLLECT, 0);
    return 0;
}

const luaL_Reg MODULE_FUNCS[] = {
    { "ping", lua_ping },
    { "take_commands", lua_take_commands },
    { "publish_state", lua_publish_state },
    { "publish_results", lua_publish_results },
    { "begin_session", lua_begin_session },
    { "epoch", lua_epoch },
    { "gc", lua_gc },
    { nullptr, nullptr },
};

} // namespace

extern "C" __declspec(dllexport) int luaopen_webconsole_bridge(lua_State* L)
{
    luaL_newlib(L, MODULE_FUNCS);
    return 1;
}
