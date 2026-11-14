# webconsole 原生插件构建
# - lua54：Lua 5.4.3 静态库（与 REFramework dependencies/lua 同源同版本），
#   排除 lua.c（解释器入口）与 luac.c（编译器入口）
# - webconsole：REFramework 插件 DLL（同时导出 luaopen_webconsole 供 Lua require）
# - webconsole_test：独立测试 exe（游戏外复现全部端点行为；不含 REFramework 插件入口）
# 运行库：/MT（静态 CRT）——插件不依赖 VC Redist，与宿主 CRT 隔离
cmake_minimum_required(VERSION 3.20)
project(webconsole LANGUAGES C CXX)
add_compile_options(/utf-8)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")

# ---- Lua 5.4.3 静态库 ----
set(LUA_DIR ${CMAKE_CURRENT_SOURCE_DIR}/lua54)
file(GLOB LUA_SOURCES "${LUA_DIR}/*.c")
# 排除两个独立入口（各自带 main），其余全部编入静态库
list(FILTER LUA_SOURCES EXCLUDE REGEX "/lua\\.c$|/luac\\.c$")

add_library(lua54 STATIC ${LUA_SOURCES})
target_include_directories(lua54 PUBLIC ${LUA_DIR})
target_compile_options(lua54 PRIVATE /W3)

# ---- webconsole 插件 DLL（REFramework 插件入口 + Lua C 模块）----
add_library(webconsole SHARED
    src/plugin_main.cpp
    src/http_server.cpp
    src/lua_bridge.cpp
    src/steam_lobby.cpp
)
target_include_directories(webconsole PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/src
    ${CMAKE_CURRENT_SOURCE_DIR}
)
target_link_libraries(webconsole PRIVATE lua54 ws2_32.lib crypt32.lib iphlpapi.lib shell32.lib)

# ---- 独立测试 exe（游戏外复现全部端点行为；不含 REFramework 插件入口） ----
add_executable(webconsole_test
    src/http_server.cpp
    src/standalone_main.cpp
)
target_include_directories(webconsole_test PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/src
    ${CMAKE_CURRENT_SOURCE_DIR}
)
target_compile_definitions(webconsole_test PRIVATE WEBCONSOLE_STANDALONE)
target_link_libraries(webconsole_test PRIVATE lua54 ws2_32.lib crypt32.lib iphlpapi.lib)

include(CTest)
if(BUILD_TESTING)
    add_executable(recovery_file_test tests/recovery_file_test.cpp)
    target_include_directories(recovery_file_test PRIVATE src ${CMAKE_CURRENT_SOURCE_DIR})
    add_test(NAME recovery_file COMMAND recovery_file_test)
    add_executable(instance_config_test tests/instance_config_test.cpp)
    target_include_directories(instance_config_test PRIVATE src ${CMAKE_CURRENT_SOURCE_DIR})
    add_test(NAME instance_config COMMAND instance_config_test)
    add_executable(bridge_lifecycle_test tests/bridge_lifecycle.cpp src/lua_bridge.cpp src/http_server.cpp src/steam_lobby.cpp)
    target_include_directories(bridge_lifecycle_test PRIVATE src ${CMAKE_CURRENT_SOURCE_DIR})
    target_link_libraries(bridge_lifecycle_test PRIVATE lua54 ws2_32.lib crypt32.lib iphlpapi.lib shell32.lib)
    add_test(NAME bridge_lifecycle COMMAND bridge_lifecycle_test)
    add_library(fake_steam SHARED tests/fake_steam.cpp)
    set_target_properties(fake_steam PROPERTIES OUTPUT_NAME steam_api64)
    add_executable(steam_lobby_test tests/steam_lobby_test.cpp src/steam_lobby.cpp)
    add_dependencies(steam_lobby_test fake_steam)
    target_include_directories(steam_lobby_test PRIVATE src ${CMAKE_CURRENT_SOURCE_DIR})
    target_link_libraries(steam_lobby_test PRIVATE advapi32.lib crypt32.lib)
    add_test(NAME steam_lobby COMMAND steam_lobby_test $<TARGET_FILE:fake_steam>)
endif()
