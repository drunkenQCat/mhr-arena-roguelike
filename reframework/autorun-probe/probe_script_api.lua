-- probe_script_api.lua — run_script 验收探针（脚本控制契约 v1 的参考实现）。
-- 由 CLI `game run-script` 触发（content 形式），整体 pcall，报告经
-- publish_probe 发布：script/epoch 自证身份，verdict 供 CLI 判定 PASS/FAIL。
local report = {
    kind = "run_script", script = "probe_script_api.lua",
    verdict = "FAIL", steps = {}, metrics = {}, error = nil,
    epoch = nil, session = nil, version = nil,
    startedAt = os.clock(),
}

local ok, err = pcall(function()
    local wc = require("webconsole")
    report.epoch, report.session, report.version = wc.epoch(), wc.session_id(), wc.version()

    local function step(name, fn)
        local s = { name = name }
        local ok2, r = pcall(fn)
        s.ok = ok2
        if not ok2 then
            s.detail = tostring(r)
            error(name .. " failed: " .. tostring(r))
        end
        s.detail = r
        table.insert(report.steps, s)
        return r
    end

    step("模块可用", function()
        assert(type(wc.ping) == "function", "webconsole.ping missing")
        return wc.version()
    end)
    step("字符串往返", function()
        local payload = "mhr-fork-" .. tostring(wc.epoch()) .. "-\x01\x255"
        assert(wc.ping(payload) == payload, "ping not byte-exact")
        return #payload
    end)
    report.metrics.epoch = wc.epoch()
    report.verdict = "PASS"
end)

if not ok then
    report.verdict, report.error = "ERROR", tostring(err) .. "\n" .. debug.traceback()
end
report.finishedAt = os.clock()

local function dumpdoc(t)
    if type(json) ~= "table" then return nil end
    local ok2, text = pcall(json.dump_string, t, 2)
    if ok2 and type(text) == "string" then return text end
    return nil
end
local text = dumpdoc(report)
if text then require("webconsole").publish_probe(text) end
