"""Lua 5.4 验收探针自检：不需要游戏、不需要 DLL，用假宿主模拟 REFramework 行为。

覆盖：
- OS 时钟（os.clock）在 5.4 中为秒：门槛不得把它当毫秒，否则探针永不执行
- require 失败（缺 DLL / 导出名不对）→ FAIL + 明确错误，不抛异常
- 同一会话重复执行 → 历史只保留最新一条（不重复展示旧记录）
- ping 篡改返回（截断/改内容）→ FAIL，而不是“调用没报错就算过”
- 连续三次脚本加载（不同 lua_State）→ 历史条目 session 互不相同
- 无效 DLL 会话号（0）→ 退回 derived 来源，不伪造唯一号
- 历史上限裁剪最旧条目；auto 入口加载即执行探针（无需手输 Lua）
"""
from pathlib import Path

from lupa.lua54 import LuaRuntime

ROOT = Path(__file__).resolve().parent.parent
PROBE = ROOT / "reframework/autorun/lua/webconsole_probe.lua"
AUTO = ROOT / "reframework/autorun/webconsole_probe_auto.lua"

PRELUDE = r"""
function dump_table(value, indent)
    indent = indent or ""
    local nested = indent .. "  "
    if type(value) == "table" then
        local parts = {}
        for k, v in pairs(value) do
            parts[#parts + 1] = nested .. "[" .. string.format("%q", tostring(k)) .. "]=" ..
                dump_table(v, nested)
        end
        return "{" .. table.concat(parts, ",") .. "}"
    elseif type(value) == "string" then
        return "\"" .. value:gsub('[%c"\\]', function(ch)
            if ch == '"' then return '\\"' end
            if ch == "\\" then return "\\\\" end
            return string.format("\\u%04x", ch:byte())
        end) .. "\""
    elseif type(value) == "number" then
        return tostring(value)
    elseif value == nil then
        return "null"
    end
    return string.format("%q", tostring(value))
end

writes = {}
loaded = {}
renderers = {}
frames = {}
fs = {
    read = function(path) return writes[path] end,
    write = function(path, text) writes[path] = text end,
}
function json_string(value)
    local escaped = value:gsub('[%c"\\\\]', function(ch)
        if ch == '"' then return '\\"' end
        if ch == "\\\\" then return "\\\\\\\\" end
        return string.format("\\\\u%04x", ch:byte())
    end)
    return '"' .. escaped .. '"'
end

function encode_literal(value)
    local kind = type(value)
    if kind == "table" then
        local parts = {}
        for _, v in ipairs(value) do parts[#parts + 1] = encode_literal(v) end
        for k, v in pairs(value) do
            if not (type(k) == "number" and k >= 1 and k <= #value and math.floor(k) == k) then
                if type(k) == "string" and k:match("^[%a_][%w_]*$") then
                    parts[#parts + 1] = k .. "=" .. encode_literal(v)
                else
                    parts[#parts + 1] = "[" .. encode_literal(tostring(k)) .. "]=" .. encode_literal(v)
                end
            end
        end
        return "{" .. table.concat(parts, ",") .. "}"
    elseif kind == "string" then
        return json_string(value)
    elseif kind == "number" then
        if value ~= value or value == math.huge or value == -math.huge then return "null" end
        return tostring(value)
    elseif kind == "boolean" then
        return value and "true" or "false"
    end
    return "null"
end

json = {
    dump_string = function(_, value) return encode_literal(value) end,
    load_string = function(text) return assert(load("return " .. text))() end,
    dump_file = function(path, value) writes[path] = encode_literal(value) end,
}
log = {
    info = function(msg) loaded[#loaded + 1] = "I:" .. tostring(msg) end,
    error = function(msg) loaded[#loaded + 1] = "E:" .. tostring(msg) end,
}
re = {
    on_frame = function(fn) frames[#frames + 1] = fn end,
    on_draw_ui = function(fn) renderers[#renderers + 1] = fn end,
}
imgui = {
    text = function(line) loaded[#loaded + 1] = "U:" .. tostring(line) end,
    separator = function() end,
    begin_window = function() return true end,
    end_window = function() end,
}
function default_module()
    local mod = {}
    mod.ping = function(s) return s end
    mod.epoch = function() return 1 end
    mod.publish_probe = function(text) published_probe = text end
    return mod
end
function run_frames(clock_after)
    for _, fn in ipairs(frames) do fn() end
end
"""


def normalize(value):
    """Lua empty tables serialize as []; convert 1..n keyed dicts back to lists."""
    if isinstance(value, dict):
        if not value:
            return []
        if all(i in value for i in range(1, len(value) + 1)):
            return [normalize(value[i]) for i in range(1, len(value) + 1)]
        return {k: normalize(v) for k, v in value.items()}
    if isinstance(value, list):
        return [normalize(v) for v in value]
    return value


class Host:
    """一次脚本加载 = 一个 lua_State（等价 REFramework Reset scripts）。"""

    def __init__(self, files=None, module="default", clock=100.0):
        self.lua = LuaRuntime(unpack_returned_tuples=True)
        self.lua.execute(PRELUDE)
        self.files = dict(files or {})
        self.clock = clock
        self.install_clock()
        if module == "default":
            self.lua.execute("package.loaded.webconsole = default_module()")
        elif module == "missing":
            pass
        elif isinstance(module, str) and module.startswith("return "):
            self.lua.execute("package.loaded.webconsole = (function() " + module + " end)()")
        if self.files:
            self.lua.globals().seed = self.lua.table_from(self.files)
            self.lua.execute("for k, v in pairs(seed) do writes[k] = v end")

    def install_clock(self):
        self.lua.globals().clock_value = self.clock
        self.lua.execute("os.clock = function() return clock_value end")

    def advance(self, seconds):
        self.clock += seconds
        self.lua.globals().clock_value = self.clock

    def load_probe(self):
        self.lua.globals().probe_source = PROBE.read_text(encoding="utf-8")
        self.lua.execute("assert(load(probe_source, '@webconsole_probe.lua'))()")

    def run_frames(self):
        self.lua.execute("run_frames()")

    def render(self):
        self.lua.execute("for _, fn in ipairs(renderers) do fn() end")

    def data(self):
        return read_literal(self.lua, "webconsole_probe.json")

    def output(self):
        return list(self.lua.eval("loaded").values())

    def writes(self):
        return self.lua.eval("writes")


def read_literal(lua, key):
    """Read back a written document through the host JSON shim (real fields, no [] ambiguity)."""
    lua.globals().read_key = key
    lua.execute(
        "local text = writes[read_key]\n"
        "assert(text, 'missing document: ' .. tostring(read_key))\n"
        "loaded_doc = assert(load('return ' .. text))()")
    return normalize(to_plain(lua.eval("loaded_doc")))


def to_plain(value):
    if hasattr(value, "items") and type(value).__module__.startswith("lupa"):
        converted = {k: to_plain(v) for k, v in value.items()}
        keys = list(converted)
        if keys and all(isinstance(k, int) for k in keys) and sorted(keys) == list(range(1, len(keys) + 1)):
            return [converted[i] for i in sorted(keys)]
        return converted
    return value


def probe_once(files=None, module="default", clock=100.0, expect_ok=None):
    host = Host(files=files, module=module, clock=clock)
    host.load_probe()
    # os.clock 是秒：必须经过至少 0.02 秒才允许执行（毫秒门槛会永远不触发）。
    host.advance(0.05)
    host.run_frames()
    data = host.data()
    if expect_ok is not None:
        assert bool(data["ok"]) is expect_ok, f"ok={data['ok']} expected {expect_ok}: {data['result']['errors']}"
    return host, data


# 1. 时钟单位：未到门槛不执行；os.clock 被误当毫秒则 frames 后仍无结果。
clock_host = Host()
clock_host.load_probe()
clock_host.run_frames()
assert "webconsole_probe.json" not in clock_host.writes(), "probe ran before the 20ms gate"
clock_host.advance(0.05)
clock_host.run_frames()
assert "webconsole_probe.json" in clock_host.writes(), "os.clock seconds treated as milliseconds"
print("PASS probe runs on os.clock seconds, not milliseconds")

# 2. require 失败 → FAIL，错误指向 DLL/导出名，且不抛异常。
host, data = probe_once(module="missing")
errors = " ".join(str(e) for e in data["result"]["errors"])
assert 'require("webconsole")' in errors and "luaopen_webconsole" in errors, errors
assert data["result"]["checks"] == [], "checks must stay empty when the module never loaded"
assert "FAIL" in "\n".join(host.output())
host.render()
assert any(line.endswith("FAIL  内存桥验收未通过") for line in host.output())
print("PASS missing module fails with DLL/export guidance and renders FAIL")

# 3. 正常模块：往返 + GC 后往返，PASS；记录版本、时间、会话。
host, data = probe_once(expect_ok=True)
result = data["result"]
checks = result["checks"]
assert [c["id"] for c in checks] == ["roundtrip", "roundtrip-after-gc"]
assert result["moduleName"] == "webconsole" and result["exportName"] == "luaopen_webconsole"
assert result["session"].startswith("derived-") and result["sessionSource"] == "derived"
assert result["atIso"].endswith("Z") and result["localTime"]
for check in checks:
    assert check["elapsedMs"] >= 0 and check["bytes"] > 20
print("PASS successful module reports roundtrip, post-GC roundtrip, time and session")

# 4. ping 篡改返回：截断 / 改内容都必须 FAIL（不能只验证“调用未报错”）。
TRUNCATING = "return { ping = function(s) return s:sub(1, #s - 1) end }"
DROPPING_NUL = "return { ping = function(s) return (s:gsub('%z', '')) end }"

host, data = probe_once(module=TRUNCATING)
assert "往返不一致" in data["result"]["errors"][0]
host, data = probe_once(module=DROPPING_NUL)
assert "往返不一致" in data["result"]["errors"][0], data["result"]["errors"]
print("PASS truncated or altered echoes fail the roundtrip check")

# 5. 同一 DLL 会话重复执行（手动重跑探针）：历史只保留一条（不重复展示旧记录）。
sticky = "package.loaded.webconsole = { ping = function(s) return s end, " \
    "session_id = function() return 'dll-1' end }"
first_host = Host()
first_host.lua.execute(sticky)
first_host.load_probe()
first_host.advance(0.05)
first_host.run_frames()
files = dict(first_host.writes().items())
second_host = Host(files=files)
second_host.lua.execute(sticky)
second_host.load_probe()
second_host.advance(0.05)
second_host.run_frames()
first = first_host.data()
second = second_host.data()
assert second["session"] == "dll-1" and second["result"]["sessionSource"] == "dll"
assert second["session"] == first["session"]
assert len(second["history"]) == 1, second["history"]
assert second["history"][0]["at"] == second["result"]["at"]
assert second["history"][0]["sessionSeq"] == 1
print("PASS same session keeps a single newest history entry")

# 6. 连续 Reset：不同 lua_State 的三个条目互不相同，按时间顺序保留。
files = {}
sessions = []
for index in range(3):
    host, data = probe_once(files=files, expect_ok=True, clock=200.0 + index * 10)
    files = dict(host.writes().items())
    sessions.append(data["session"])
assert len(set(sessions)) == 3, sessions
assert len(data["history"]) == 3
history = data["history"]
assert [h["session"] for h in history] == sessions
assert [h["sessionSeq"] for h in history] == [1, 2, 3]
assert history[-1]["session"] == data["session"]
print("PASS consecutive resets produce distinct, ordered session entries")

# 7. DLL 会话号 0：不伪造唯一号，浏览器侧按 null 显示。
host = Host(module=lambda: host_mod_with_zero())
host.lua.execute(
    "package.loaded.webconsole = { ping = function(s) return s end, session_id = function() return 0 end }")
host.load_probe()
host.advance(0.05)
host.run_frames()
data = host.data()
assert data["result"]["session"] == "derived-" or data["result"]["sessionSource"] == "derived", data["result"]
print("PASS invalid DLL session id falls back instead of faking uniqueness")

# 8. 历史上限：超过 8 条裁掉最旧的。
files = {}
for index in range(10):
    host, data = probe_once(files=files, expect_ok=True, clock=300.0 + index * 10)
    files = dict(host.writes().items())
hist = data["history"]
assert len(hist) == 8, len(hist)
assert hist[-1]["session"] == data["session"]
print("PASS history is capped and keeps the newest entries")

# 9. auto 入口：不手输 Lua，加载即执行探针。
boot = Host(files=dict(files))
boot.lua.globals().probe_module_source = PROBE.read_text(encoding="utf-8")
# The loader resolves the probe through package.path search (autorun/lua/?).
boot.lua.execute(
    "package.path = package.path .. ';./reframework/autorun/?.lua'")
auto_host = boot
auto_host.lua.globals().auto_source = AUTO.read_text(encoding="utf-8")
# package.searchpath hits the real file on disk (repo checkout stands in for
# autorun/); loadfile inside the loader resolves the same way.
auto_host.lua.execute("assert(load(auto_source, '@webconsole_probe_auto.lua'))()")
auto_host.advance(0.05)
auto_host.run_frames()
assert "webconsole_probe.json" in auto_host.writes(), "auto entry did not run the probe"
boot_data = read_literal(auto_host.lua, "webconsole_probe_boot.json")
assert boot_data["ok"] is True, boot_data
print("PASS autorun entry loads the probe without manual Lua input")


# 10. 发布到内存桥：页面用 /api/probe/report 的数据，不依赖磁盘文件。
host, data = probe_once(expect_ok=True)
published = host.lua.eval("published_probe")
assert isinstance(published, str) and "history" in published, "probe did not publish its report"
assert str(data["session"]) in published
print("PASS probe publishes its report over the memory bridge")
print("ALL PROBE CHECKS PASSED")