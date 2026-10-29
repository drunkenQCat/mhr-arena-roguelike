#pragma once
struct lua_State;
namespace webconsole {
void attach_lua_bridge(lua_State* L);
}
