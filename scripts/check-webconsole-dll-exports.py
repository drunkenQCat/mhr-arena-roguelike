"""导出/装载检查：不操作宿主 Lua state，不构成游戏内 ABI 或 GC 验收。

做法：lupa 的 LuaRuntime 自带一份 Lua 5.4 解释器，但它不是我们 DLL 静态链接的
那份 lua54 库，所以不能直接把宿主 state 传给 luaopen_webconsole（这正是任务书
禁止的“拿别的 VM 当同一个”）。替代方案：用 ctypes 加载 DLL，取 luaopen_webconsole
与 DLL 内静态链接的 lua_* 符号——但 DLL 只导出了 luaopen_webconsole 一个 Lua
符号，静态库符号不导出，无法在进程外构造 lua_State。

因此本文件验证三件可以严格验证的事：
1. DLL 导出表：luaopen_webconsole 存在，luaopen_webconsole_bridge 不存在（契约改名完成）；
2. REFramework 插件导出存在；
3. 探针 Lua 脚本在 lupa 的 Lua 5.4 中，对“假 DLL”跑完整验收流程（既有 harness）。

真实游戏内 require 的验证只能由游戏进程完成：探针脚本 + auto 入口已由
scripts/check-webconsole-probe.py 在语义层面覆盖（require 失败路径、GC 后往返、
连续 Reset 会话区分）。游戏内验收步骤写在 docs/evidence 里。
"""
import ctypes
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DLL = ROOT / "native/webconsole/webconsole.dll"

# 1. 导出表检查（dumpbin 可能不在 PATH，回退到 PE 解析）
exports = []
try:
    out = subprocess.run(["dumpbin", "/exports", str(DLL)], capture_output=True, text=True, timeout=60)
    exports = re.findall(r"^\s+\d+\s+[0-9A-F]+\s+[0-9A-F]+\s+(\S+)$", out.stdout, re.M)
except (OSError, subprocess.TimeoutExpired):
    pass

if not exports:
    # 手工解析 PE 导出表
    import struct
    data = DLL.read_bytes()
    pe = struct.unpack_from("<I", data, 0x3C)[0]
    assert data[pe:pe+4] == b"PE\0\0", "not a PE"
    opt = pe + 24
    magic = struct.unpack_from("<H", data, opt)[0]
    assert magic == 0x20B, "PE32+ expected"
    dd = opt + 112  # data directories (PE32+)
    exp_rva, exp_size = struct.unpack_from("<II", data, dd)
    sec_count = struct.unpack_from("<H", data, pe + 6)[0]
    sec_start = opt + 240
    def rva2off(rva):
        for i in range(sec_count):
            s = sec_start + 40*i
            vsize, va = struct.unpack_from("<II", data, s+8)
            praw = struct.unpack_from("<I", data, s+20)[0]
            if va <= rva < va + vsize:
                return rva - va + praw
        raise KeyError(hex(rva))
    e = rva2off(exp_rva)
    name_rva, ordinal_base, nfuncs, nnames, aof, aon, aono = struct.unpack_from("<7I", data, e+12)
    noff = rva2off(aon)
    exports = []
    for i in range(nnames):
        ptr_rva, = struct.unpack_from("<I", data, noff + 4*i)
        off = rva2off(ptr_rva)
        end = data.index(b"\0", off)
        exports.append(data[off:end].decode("ascii", "replace"))

assert "luaopen_webconsole" in exports, exports
assert "luaopen_webconsole_bridge" not in exports, "old export name still present"
assert "reframework_plugin_initialize" in exports, exports
assert "reframework_plugin_required_version" in exports, exports
print(f"PASS DLL exports: {len(exports)} symbols, luaopen_webconsole present, old name gone")

# 2. DLL 会话号/版本探测端点口径：本进程加载 DLL 后 DllMain 生成会话号（无法在
# 进程外读取），改为验证导出函数可解析（加载即执行 DllMain，不产生副作用文件）。
lib = ctypes.WinDLL(str(DLL))
assert hasattr(lib, "luaopen_webconsole")
print("PASS DLL loads in-proc and luaopen_webconsole resolves")

# 3. 探针脚本语义（复用既有 harness）
harness = subprocess.run([sys.executable, str(ROOT / "scripts/check-webconsole-probe.py")],
                         capture_output=True, text=True)
assert harness.returncode == 0, harness.stdout + harness.stderr
tail = [l for l in harness.stdout.strip().splitlines() if l.startswith("PASS") or "ALL" in l]
for line in tail:
    print("PASS", line.split("PASS ", 1)[1] if line.startswith("PASS ") else line)

print("ALL DLL-EXPORT CHECKS PASSED")