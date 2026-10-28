@echo off
call "C:\Program Files\Microsoft Visual Studio‚2\Community\VC\Auxiliary\Buildcvars64.bat" >nul 2>&1
cl /nologo /std:c++20 /EHsc /c /I. /Isrc /Ireframework src\http_server.cpp src\plugin_main.cpp
