@echo off
set MSVC_DIR=C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Tools\MSVC
for /f "delims=" %%i in ('dir /b /ad "%MSVC_DIR%"') do set MSVC_VER=%%i
set TOOLS=%MSVC_DIR%\%MSVC_VER%\bin\Hostx64\x64
set INCLUDE=%MSVC_DIR%\%MSVC_VER%\include;C:\Program Files (x86)\Windows Kits\10\Include\10.0.26100.0\ucrt;C:\Program Files (x86)\Windows Kits\10\Include\10.0.26100.0\um;C:\Program Files (x86)\Windows Kits\10\Include\10.0.26100.0\shared
set LIB=%MSVC_DIR%\%MSVC_VER%\lib\x64;C:\Program Files (x86)\Windows Kits\10\Lib\10.0.26100.0\ucrt\x64;C:\Program Files (x86)\Windows Kits\10\Lib\10.0.26100.0\um\x64
"%TOOLS%\cl.exe" /nologo /std:c++20 /Od /Zi /EHsc /DWEBCONSOLE_STANDALONE webconsole.cpp /Fe:webconsole_dbg.exe /link ws2_32.lib crypt32.lib /MAP
