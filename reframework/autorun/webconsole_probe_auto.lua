-- 独立 autorun 入口：加载后自动执行内存桥探针，无需手输 Lua。
-- 部署位置：<game>/reframework/autorun/webconsole_probe_auto.lua
-- 探针本体：<game>/reframework/autorun/lua/webconsole_probe.lua
--
-- ScriptRunner 把 <autorun>/?.lua 加进 package.path；先用 package.searchpath
-- 解析出实际文件，再 loadfile 该路径（loadfile 只按字符串路径读取，不做
-- package.path 展开，所以两步分开做）。fs.read 沙箱只放行 data 目录，
-- 不用它读 autorun。
-- 探针缺失或抛错只记录状态，不影响其它 autorun 脚本继续加载。

local CANDIDATES = {
    "lua/webconsole_probe",       -- 通过 <autorun>/?.lua 模板解析为 lua/webconsole_probe.lua
    "lua/webconsole_probe.lua",   -- 完整路径（package.path 未含 /lua 时也能直接 loadfile）
    "webconsole_probe.lua",
}

local function report(state)
    if type(json) == "table" and type(json.dump_file) == "function" then
        pcall(json.dump_file, "webconsole_probe_boot.json", state, 2)
    end
    if type(log) == "table" and type(log.info) == "function" then
        log.info(string.format("[WebConsoleProbe] boot %s %s",
            state.ok and "ok" or "failed", tostring(state.error or "")))
    end
end

local chunk, used, last_error
for _, candidate in ipairs(CANDIDATES) do
    local ok_find, found = pcall(package.searchpath, candidate, package.path)
    if not ok_find or type(found) ~= "string" then
        last_error = found
    else
        -- loadfile 接受完整路径；找到的绝对/相对路径都在 autorun 下。
        local ok_load, fn = pcall(loadfile, found)
        if ok_load and type(fn) == "function" then
            chunk, used = fn, found
            break
        end
        last_error = fn
    end
end

if not chunk then
    report({ ok = false, error = "probe not loadable: " .. tostring(last_error)
        .. " (looked for " .. table.concat(CANDIDATES, ", ") .. ")", at = os.time() })
    return
end

local ok_run, probe = pcall(chunk)
if not ok_run then
    report({ ok = false, error = "probe crashed: " .. tostring(probe), at = os.time() })
    return
end

report({ ok = true, loaded = used, at = os.time() })