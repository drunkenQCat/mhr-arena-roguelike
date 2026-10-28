-- webconsole DLL ↔ 宿主 Lua 验收探针（独立 autorun 脚本，不依赖 mhw_rogue bundle）。
--
-- 部署位置：<game>/reframework/autorun/lua/webconsole_probe.lua，并由
-- <game>/reframework/autorun/webconsole_probe_auto.lua 在 pcall 中执行它——探针自身
-- 出错也不能阻止脚本继续加载。
--
-- 每次脚本加载（含 REFramework → ScriptRunner → Reset scripts）自动完成：
--   1. require("webconsole")  模块名 = DLL 文件名 = 导出函数名 luaopen_webconsole
--   2. 字符串往返：二进制安全字节 + 中文 UTF-8，ping(s) 必须逐字节原样返回
--   3. collectgarbage("collect") 后再往返一次：排除 GC 后悬垂指针/错误长度
-- 记录本次运行时间、DLL 模块版本、进程号、会话号；覆盖写 reframework/data/webconsole_probe.json
-- （同时写 JSONP 版本 webconsole_probe.js 供页面备用），历史保留 8 条且会话号去重。
-- Generated UI：re.on_draw_ui 窗口「WebConsole Probe」显示 PASS/FAIL、本次运行信息与历史。
--
-- 只用 REFramework 固定版本(5bae4701)与 master 都存在的 API：re.on_frame /
-- re.on_draw_ui / log / json / fs / os / imgui / io.open(仅本地 harness 用于自回写)。

local MODULE = "webconsole"
local DATA_FILE = "webconsole_probe.json"
local JS_FILE = "webconsole_probe.js"
local STATUS_FILE = "webconsole_probe_status.json"
local HISTORY_LIMIT = 8
local STEP_SECONDS = 0.02

-- math.randomseed 在同一秒内重复调用会产生同一序列（= 连续 Reset 的会话号撞车），
-- 因此种子再混入 os.clock 微秒与脚本地址。
local ok_seed, seed = pcall(function()
    local script = debug and debug.getinfo and debug.getinfo(1, "S")
    return os.time() * 1000000 + math.floor((os.clock() % 1) * 1000000) +
        #tostring(script and script.source or "")
end)
math.randomseed(ok_seed and seed or 1)

local state = {
    result = nil,
    history = {},
    finished = false,
    startedAt = os.clock(),
}

-- os.clock 在 Lua 5.4 返回秒（不是毫秒）；把它当毫秒会让 20 ms 门槛永远不触发。
local function elapsed_seconds()
    return os.clock() - state.startedAt
end

local function dump_values(props, values)
    if type(json) ~= "table" then return nil end
    local ok, text = pcall(json.dump_string, props, values, 2)
    if ok and type(text) == "string" then return text end
    if type(json.stringify) == "function" then
        local ok2, text2 = pcall(json.stringify, values, nil, 2)
        if ok2 and type(text2) == "string" then return text2 end
    end
    return nil
end

local function parse_text(text)
    if type(text) ~= "string" or #text == 0 or type(json) ~= "table" then return nil end
    if type(json.load_string) == "function" then
        local ok, value = pcall(json.load_string, text)
        if ok then return value end
    end
    if type(json.parse) == "function" then
        local ok, value = pcall(json.parse, text)
        if ok then return value end
    end
    return nil
end

-- fs 在宿主里是受沙箱限制的模块；本地 harness 里是真实文件操作。两条路径都不抛。
local function read_text(path)
    if type(fs) == "table" and type(fs.read) == "function" then
        local ok, text = pcall(fs.read, path)
        if ok and type(text) == "string" then return text end
    end
    if type(io) == "table" and type(io.open) == "function" then
        local file = io.open(path, "rb")
        if file then
            local text = file:read("*a")
            file:close()
            return text
        end
    end
    return nil
end

local function write_text(path, text)
    if type(fs) == "table" and type(fs.write) == "function" then
        local ok = pcall(fs.write, path, text)
        if ok then return true end
    end
    if type(io) == "table" and type(io.open) == "function" then
        local file = io.open(path, "wb")
        if file then
            file:write(text)
            file:close()
            return true
        end
    end
    return false
end

-- 同进程内严格递增的加载序号：即便随机数重复，连续 Reset 的会话号也不同。
local LOAD_COUNTER_FILE = "webconsole_probe_seed.txt"
local function next_load_ordinal()
    local previous = tonumber(read_text(LOAD_COUNTER_FILE)) or 0
    local ordinal = previous + 1
    write_text(LOAD_COUNTER_FILE, tostring(ordinal))
    return ordinal
end

-- 会话号：优先用 DLL 的 session_id（DLL 常驻不重置时也能区分新脚本代）；
-- 旧 DLL 无此函数时退回 进程加载序号 + 时间 + 随机数，仍能对比连续 Reset。
local function derive_session(mod)
    if type(mod) == "table" and type(mod.session_id) == "function" then
        local ok, value = pcall(mod.session_id)
        if ok and type(value) == "string" and #value > 0 and value ~= "0" then
            return value, "dll"
        end
    end
    return string.format("derived-%d-%d-%d", next_load_ordinal(), os.time(),
        math.random(0, 999999999)), "derived"
end

local function previous_history()
    local data = parse_text(read_text(DATA_FILE))
    local history = {}
    if type(data) == "table" and type(data.history) == "table" then
        for _, item in ipairs(data.history) do
            if type(item) == "table" and type(item.session) == "string" then
                history[#history + 1] = item
            end
        end
    end
    return history
end

local function roundtrip(mod, label)
    local payload = string.format(
        "webconsole-probe|%s|\228\184\173\230\150\135|\0\1\255|%d",
        label, math.random(0, 2147483647))
    local started = os.clock()
    local ok, echoed = pcall(mod.ping, payload)
    local elapsed = (os.clock() - started) * 1000
    if not ok then
        return false, string.format("%s: ping 抛错 %s", label, tostring(echoed)), elapsed, #payload
    end
    if type(echoed) ~= "string" then
        return false, string.format("%s: 返回 %s，应为 string", label, type(echoed)), elapsed, #payload
    end
    if echoed ~= payload then
        return false, string.format("%s: 往返不一致（发送 %d 字节，收到 %d 字节）",
            label, #payload, #echoed), elapsed, #payload
    end
    return true, string.format("%s: %d 字节原样返回，%.2f ms", label, #payload, elapsed),
        elapsed, #payload
end

local function read_dll_status()
    local status = parse_text(read_text(STATUS_FILE))
    if type(status) ~= "table" then return nil end
    return status
end

local function run_probe()
    local started = os.clock()
    local result = {
        schema = 1,
        ok = false,
        at = os.time(),
        atIso = os.date("!%Y-%m-%dT%H:%M:%SZ"),
        localTime = os.date("%Y-%m-%d %H:%M:%S"),
        moduleName = MODULE,
        exportName = "luaopen_" .. MODULE,
        loadedScript = (function()
            local info = debug and debug.getinfo and debug.getinfo(1, "S")
            return info and info.source or "?"
        end)(),
        checks = {},
        errors = {},
    }

    local required, mod = pcall(require, MODULE)
    if not required or type(mod) ~= "table" then
        result.errors[#result.errors + 1] = string.format(
            'require("%s") 失败：%s —— 检查 webconsole.dll 是否在 reframework/plugins 或 autorun 目录、' ..
            "是否先于本脚本加载、导出名是否为 luaopen_%s", MODULE, tostring(mod), MODULE)
    elseif type(mod.ping) ~= "function" then
        result.errors[#result.errors + 1] =
            "模块存在但缺少 ping 函数（加载了错误的 DLL 或版本过旧）"
    end

    result.session, result.sessionSource = derive_session(mod)
    if type(mod) == "table" then
        if type(mod.epoch) == "function" then
            local ok_epoch, epoch = pcall(mod.epoch)
            if ok_epoch and type(epoch) == "number" then result.epoch = epoch end
        end
    end

    local status = read_dll_status()
    if status then
        result.dll = status
        result.moduleVersion = type(status.moduleVersion) == "string" and status.moduleVersion or nil
        result.pid = type(status.pid) == "number" and status.pid or nil
        result.versionSource = "dll_required_version"
    end
    if type(result.moduleVersion) ~= "string" and type(mod) == "table" and type(mod.version) == "function" then
        local ok_version, version = pcall(mod.version)
        if ok_version and type(version) == "string" then
            result.moduleVersion = version
            result.versionSource = "luaopen"
        end
    end
    if type(result.moduleVersion) ~= "string" then result.versionSource = "unknown" end

    if type(mod) == "table" and type(mod.ping) == "function" then
        local pass1, msg1, ms1, bytes1 = roundtrip(mod, "ping")
        result.checks[#result.checks + 1] = { id = "roundtrip", ok = pass1, message = msg1,
            elapsedMs = ms1, bytes = bytes1 }
        if not pass1 then result.errors[#result.errors + 1] = msg1 end

        local gc_started = os.clock()
        collectgarbage("collect")
        collectgarbage("step")
        collectgarbage("collect")
        local gc_ms = (os.clock() - gc_started) * 1000
        local pass2, msg2, ms2, bytes2 = roundtrip(mod, "ping-after-gc")
        result.checks[#result.checks + 1] = { id = "roundtrip-after-gc", ok = pass2,
            message = msg2, elapsedMs = ms2, bytes = bytes2, gcMs = gc_ms }
        if not pass2 then result.errors[#result.errors + 1] = msg2 end
    end

    result.ok = #result.errors == 0 and #result.checks == 2
    result.durationMs = (os.clock() - started) * 1000
    return result
end

-- 同一会话号只保留一条（覆盖），保证连续 Reset 的历史条目互不相同。
local function merge_history(history, result)
    local merged = {}
    for _, item in ipairs(history) do
        if item.session ~= result.session then merged[#merged + 1] = item end
    end
    merged[#merged + 1] = result
    while #merged > HISTORY_LIMIT do table.remove(merged, 1) end
    for index, item in ipairs(merged) do
        item.sessionSeq = index
        if item ~= result then item.previous = true end
    end
    return merged
end

local function persist(result)
    local merged = merge_history(previous_history(), result)
    local document = {
        schema = 1,
        ok = result.ok,
        module = MODULE,
        session = result.session,
        sessionSeq = result.sessionSeq,
        moduleVersion = result.moduleVersion,
        at = result.at,
        atIso = result.atIso,
        result = result,
        history = merged,
    }
    local text = dump_values(nil, document)
    if text then
        document.persisted = write_text(DATA_FILE, text)
        write_text(JS_FILE, "window.MHR_PROBE=" .. text .. ";")
        -- 直接发布到内存桥：页面无需读磁盘即可显示 PASS/FAIL 与会话历史。
        local module = package.loaded and package.loaded[MODULE]
        if type(module) == "table" and type(module.publish_probe) == "function" then
            pcall(module.publish_probe, text)
        end
    end
    state.history = merged
    return merged
end

local function check_lines(result)
    local lines = {}
    for _, check in ipairs(result.checks or {}) do
        lines[#lines + 1] = string.format("%s  %s", check.ok and "PASS" or "FAIL",
            check.message or check.id)
    end
    return lines
end

local function draw(result)
    if type(imgui) ~= "table" or type(imgui.text) ~= "function" then return end
    local open = true
    if type(imgui.begin_window) == "function" then
        open = imgui.begin_window("WebConsole Probe", true, 0)
        if not open then
            if type(imgui.end_window) == "function" then imgui.end_window() end
            return
        end
    end
    if result then
        imgui.text(result.ok and "PASS  内存桥可用：字符串往返 + GC 后往返均成立"
            or "FAIL  内存桥验收未通过")
        imgui.text(string.format("会话 %s (%s)  #%d  运行 %d ms",
            tostring(result.session), tostring(result.sessionSource),
            result.sessionSeq or 0, math.floor(result.durationMs or 0)))
        imgui.text(string.format("时间 %s（本地 %s）", tostring(result.atIso),
            tostring(result.localTime)))
        imgui.text(string.format("模块版本 %s（来源 %s）", tostring(result.moduleVersion),
            tostring(result.versionSource)))
        if result.dll then
            imgui.text(string.format("DLL pid %s  运行 %s s  已服务会话 %s  ping 调用 %s",
                tostring(result.dll.pid),
                tostring(math.floor((result.dll.uptimeMs or 0) / 1000)),
                tostring(result.dll.sessions), tostring(result.dll.pings)))
            imgui.text(string.format("POST /api/command %s 条", tostring(result.dll.commands)))
        end
        imgui.text(string.format("require(\"%s\") → %s", MODULE, tostring(result.exportName)))
        for _, line in ipairs(check_lines(result)) do imgui.text(line) end
        for _, err in ipairs(result.errors or {}) do imgui.text("错误  " .. tostring(err)) end
    else
        imgui.text("探针等待 Lua 回调…（首帧后自动执行）")
    end
    if type(imgui.separator) == "function" then imgui.separator() end
    imgui.text(string.format("历史 %d 条（同一会话只留最新，最新在下）", #state.history))
    for _, item in ipairs(state.history) do
        imgui.text(string.format("[%s] %s  %s  %d ms", tostring(item.atIso),
            item.ok and "PASS" or "FAIL", tostring(item.session),
            math.floor(item.durationMs or 0)))
    end
    if type(imgui.end_window) == "function" then imgui.end_window() end
end

-- 结果在 on_frame 里跑：require 加载 DLL、调用 C 函数都放在受保护的脚本回调里，
-- 不在 autorun 顶层阻塞脚本加载；一次会话只探测一次（历史去重，不每帧重跑）。
local function tick()
    if state.finished then return end
    if elapsed_seconds() < STEP_SECONDS then return end
    state.finished = true
    local result = run_probe()
    state.result = result
    persist(result)
    if type(log) == "table" and type(log.info) == "function" then
        log.info(string.format("[WebConsoleProbe] %s session=%s seq=%d version=%s %.1fms",
            result.ok and "PASS" or "FAIL", tostring(result.session), result.sessionSeq or 0,
            tostring(result.moduleVersion), result.durationMs or 0))
        for _, err in ipairs(result.errors) do
            if type(log.error) == "function" then log.error("[WebConsoleProbe] " .. tostring(err)) end
        end
    end
end

_G.webconsole_probe = {
    run = function()
        local fresh = run_probe()
        state.result = fresh
        persist(fresh)
        return fresh, state.history
    end,
    last = function() return state.result, state.history end,
}

if type(re) == "table" then
    if type(re.on_frame) == "function" then pcall(re.on_frame, tick) end
    if type(re.on_draw_ui) == "function" then
        pcall(re.on_draw_ui, function() draw(state.result) end)
    end
end

return state