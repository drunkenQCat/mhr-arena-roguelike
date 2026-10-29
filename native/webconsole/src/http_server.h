// HTTP server: all endpoint registration and the cpp-httplib threading model.
// Routes are registered one path at a time: the multi-path initializer_list overload
// matches with a regex at request time and once raised an uncaught regex_error.
#pragma once

#include "common.h"

namespace webconsole {

void start_http_server();

} // namespace webconsole
