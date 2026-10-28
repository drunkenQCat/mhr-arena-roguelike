// HTTP 服务器：全部端点注册与 cpp-httplib 线程模型。
// 路由注册必须逐个单路径——多路径 initializer_list 重载在请求处理时走 regex
// 匹配路径，曾触发未捕获 regex_error 导致进程 terminate（实机崩溃教训）。
#pragma once

#include "common.h"

#include "httplib.h"

namespace webconsole {

void start_http_server();

} // namespace webconsole
