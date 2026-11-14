// Contract tests for the CLI without a running game.
//
// A local HTTP server plays the plugin: it implements the endpoint surface and the
// failure modes that matter (503 before Lua publishes, 4xx refusals, dropped
// connections, receipts that never arrive), so the CLI's exit codes and
// no-auto-retry rule are exercised where a live game cannot be scripted.
//
// Run: node cli/tests/contract.mjs   (also wired as `npm run test:cli`)
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { readFileSync } from "node:fs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = join(ROOT, "cli", "mhr.mjs");

let failures = 0;
function check(name, condition, detail) {
  if (condition) { console.log(`PASS ${name}`); return; }
  failures += 1;
  console.log(`FAIL ${name}${detail ? `: ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
}

/** Minimal plugin double. `behaviour` mutates responses per scenario. */
function createPlugin(behaviour = {}) {
  const state = {
    protocol: 4,
    bridgeId: "bridge-1",
    counter: 0,
    sessionStage: "Selecting",
    questUnique: 42,
    preparation: { waveToken: 7 },
    configVersion: 3,
    armorOptions: ["骨套（均衡）"],
    capabilities: { start: true, choose: true, stop: true },
    shopAvailable: true,
    shopBusy: false,
    shop: { "基础补给": [{ id: "potion", name: "回复药", category: "基础补给", price: 10,
      cap: 10, owned: 3, mode: "perUnit", canBuy: true }] },
    pt: 200,
    enemies: [{ uid: 11, typeId: 98, dead: false, captured: false }],
    choices: [{ index: 0, label: "Single", monsters: ["镰鼬龙王"], mode: "single",
      hpMul: 1, dmgMul: 1, rewardPt: 10 }],
    message: "test",
  };
  const received = [];
  const receipts = [];
  const server = createServer((req, res) => {
    const json = (status, body) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const url = new URL(req.url, "http://127.0.0.1");
    if (req.method === "GET") {
      state.counter += 1;
      if (url.pathname === "/api/health") return json(200, { ok: true, plugin: "webconsole", version: "test" });
      if (url.pathname === "/api/probe") return json(200, { ok: true, plugin: "webconsole",
        module: "webconsole", export: "luaopen_webconsole", moduleVersion: "test",
        protocol: behaviour.dllProtocol ?? 4, pid: 1, session: "s-1", uptimeMs: 1000,
        sessions: 1, stateSeq: 1, queuedCommands: 0, commands: received.length, pings: 1,
        transport: "memory" });
      if (url.pathname === "/api/probe/report") {
        if (behaviour.noProbe) return json(503, { ok: false, error: "probe has not reported yet" });
        if (state.scriptQueued && behaviour.staleProbeFirst && state.probeReads++ === 0)
          return json(200, { script: state.scriptQueued.script, epoch: state.scriptQueued.epoch, verdict: "PASS", executionId: "old-execution" });
        if (state.scriptQueued) return json(200, { ok: true, kind: "run_script",
          script: state.scriptQueued.script, epoch: state.scriptQueued.epoch, executionId: state.scriptQueued.executionId,
          verdict: behaviour.probeVerdict ?? "PASS", steps: [], metrics: {}, error: null });
        return json(200, { schema: 1, ok: true, session: "s-1:lua-1", moduleVersion: "test",
          atIso: "2026-01-01T00:00:00Z", result: { checks: [], errors: [] }, history: [] });
      }
      if (url.pathname === "/api/state") {
        if (behaviour.noLua) return json(503, { ok: false, error: "Lua bridge has not published state yet" });
        return json(200, { ok: true, ...state, ...(behaviour.statePatch?.(state) ?? {}) });
      }
      if (url.pathname === "/api/results") {
        if (behaviour.noLua) return json(503, { ok: false, error: "Lua bridge has not published results yet" });
        return json(200, { bridgeId: behaviour.bridgeForResults ?? "bridge-1",
          lastId: receipts.at(-1)?.id ?? "", last: receipts.at(-1) ?? null, history: receipts });
      }
      if (url.pathname === "/api/script/error") {
        return json(200, behaviour.scriptError ?? { ok: true, available: true, hasError: false, error: "" });
      }
      return json(404, { ok: false, error: "not found" });
    }
    if (req.method === "POST" && url.pathname === "/api/command") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        let command = null;
        try { command = JSON.parse(body); } catch { /* malformed */ }
        if (behaviour.commandStatus) return json(behaviour.commandStatus,
          { ok: false, error: "refused by test" });
        if (behaviour.dropConnection) { req.socket.destroy(); return; }
        received.push(command);
        if (!behaviour.neverReceipt) {
          const receipt = { id: command.id, status: behaviour.receiptStatus ?? "applied",
            message: "ok", ...(behaviour.receiptPatch?.(command) ?? {}) };
          receipts.push(receipt);
        }
        json(200, { ok: true, queued: true, bytes: body.length });
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/script/reset") {
      if (behaviour.scriptUnavailable) return json(503, { ok: false, error: "framework script API unavailable" });
      received.push({ endpoint: "script/reset" });
      return json(200, { ok: true, queued: true, action: "reset_scripts", epoch: 9, session: "s-1" });
    }
    if (req.method === "POST" && url.pathname === "/api/script/run") {
      if (behaviour.scriptUnavailable) return json(503, { ok: false, error: "framework script API unavailable" });
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        let payload = {};
        try { payload = JSON.parse(body); } catch { /* malformed */ }
        received.push({ endpoint: "script/run", payload });
        if (behaviour.runReject) return json(behaviour.runReject, { ok: false, error: "file not found in game tree" });
        // Model the probe contract: the queued script publishes a report carrying
        // its name and the epoch that was current when the run was queued.
        state.scriptQueued = {
          script: JSON.parse(payload.content.match(/script=("[^"]+")/)[1]),
          executionId: JSON.parse(payload.content.match(/local __mhr_execution_id=("[^"]+")/)[1]),
          epoch: behaviour.runEpoch ?? 9 };
        state.probeReads = 0;
        json(200, { ok: true, queued: true, script: state.scriptQueued.script,
          epoch: state.scriptQueued.epoch, session: "s-1" });
      });
      return;
    }
    json(404, { ok: false, error: "not found" });
  });
  return { server, state, received, receipts };
}

function runCli(args, { baseUrl } = {}) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [CLI, ...args, ...(baseUrl ? ["--base-url", baseUrl] : [])], {
      cwd: ROOT, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolveRun({ code, stdout, stderr }));
  });
}

async function withPlugin(behaviour, fn) {
  const plugin = createPlugin(behaviour);
  await new Promise((ready) => plugin.server.listen(0, "127.0.0.1", ready));
  const { port } = plugin.server.address();
  try { return await fn(`http://127.0.0.1:${port}`, plugin); }
  finally { await new Promise((done) => plugin.server.close(done)); }
}

// 1. Missing server: exit 3, no fabricated success.
{
  const result = await runCli(["state", "--json"], { baseUrl: "http://127.0.0.1:1" });
  check("missing server exits 3", result.code === 3, result);
  check("missing server reports JSON failure", JSON.parse(result.stdout).ok === false, result.stdout);
}

// 2. DLL up, Lua silent: doctor must separate the layers.
await withPlugin({ noLua: true, noProbe: true }, async (baseUrl) => {
  const result = await runCli(["doctor", "--json"], { baseUrl });
  const report = JSON.parse(result.stdout);
  check("doctor: HTTP up with silent Lua", report.layers.http.state === "up", report.layers);
  check("doctor: business unavailable", report.layers.business.state === "unavailable", report.layers.business);
  check("doctor exits 3 when not ready", result.code === 3, result.code);
  const state = await runCli(["state"], { baseUrl });
  check("state exits 3 before Lua publishes", state.code === 3, state.code);
});

// 3. Ready plugin: reads succeed and identity is echoed into commands.
await withPlugin({}, async (baseUrl, plugin) => {
  const state = await runCli(["state", "--json"], { baseUrl });
  check("state exits 0 when ready", state.code === 0, state.stderr);
  const route = await runCli(["run", "route", "inPlace"], { baseUrl });
  check("run route exits 0", route.code === 0, route.stderr);
  const sent = plugin.received.at(-1);
  check("command carries identity", sent?.bridgeId === "bridge-1" && sent?.questUnique === 42 &&
    sent?.waveToken === 7 && sent?.configVersion === 3, sent);
  check("command carries a unique id", typeof sent?.id === "string" && sent.id.startsWith("setRoute-"), sent?.id);

  const choose = await runCli(["run", "choose", "--index", "0"], { baseUrl });
  check("run choose exits 0", choose.code === 0, choose.stderr);
  check("choose sends index", plugin.received.at(-1)?.index === 0, plugin.received.at(-1));

  const shop = await runCli(["shop", "list", "--json"], { baseUrl });
  check("shop list exits 0 and lists items", shop.code === 0 && JSON.parse(shop.stdout).items.length === 1,
    shop.stdout.slice(0, 120));

  const caps = await runCli(["capabilities", "--json"], { baseUrl });
  const matrix = JSON.parse(caps.stdout);
  check("capabilities reports allowed run.choose", matrix.actions.find((a) => a.action === "run.choose")?.allowed === true,
    matrix.actions);
});

// 4. Refusals and uncertain outcomes keep their own exit codes.
await withPlugin({ commandStatus: 403 }, async (baseUrl) => {
  const result = await runCli(["run", "stop"], { baseUrl });
  check("403 command exits 4", result.code === 4, result.stderr);
});
await withPlugin({ commandStatus: 429 }, async (baseUrl) => {
  const result = await runCli(["run", "stop"], { baseUrl });
  check("429 queue-full exits 4", result.code === 4, result.stderr);
});
await withPlugin({ dropConnection: true }, async (baseUrl) => {
  const result = await runCli(["run", "stop"], { baseUrl });
  check("dropped connection exits 6 (uncertain)", result.code === 6, result.stderr);
});
await withPlugin({ neverReceipt: true }, async (baseUrl) => {
  const result = await runCli(["run", "stop", "--receipt-timeout", "1"], { baseUrl });
  check("missing receipt exits 5 (timeout)", result.code === 5, result.stderr);
});
await withPlugin({ receiptStatus: "rejected" }, async (baseUrl) => {
  const result = await runCli(["run", "stop"], { baseUrl });
  check("rejected receipt exits 4", result.code === 4, result.stderr);
});
await withPlugin({ receiptStatus: "uncertain" }, async (baseUrl) => {
  const result = await runCli(["run", "stop"], { baseUrl });
  check("uncertain receipt exits 6", result.code === 6, result.stderr);
});
await withPlugin({ bridgeForResults: "bridge-2" }, async (baseUrl) => {
  const result = await runCli(["run", "stop"], { baseUrl });
  check("bridge change exits 6 and never resends", result.code === 6, result.stderr);
});

// 5. purchase preconditions are refused locally with 4, without posting.
await withPlugin({ statePatch: () => ({ shopAvailable: true,
  shop: { "基础补给": [{ id: "potion", name: "回复药", category: "基础补给", price: 10,
    cap: 10, owned: 10, mode: "perUnit", canBuy: false, reason: "已达持有上限" }] } }) },
async (baseUrl, plugin) => {
  const result = await runCli(["shop", "buy", "--item", "potion"], { baseUrl });
  check("unbuyable item exits 4", result.code === 4, result.stderr);
  check("unbuyable item is never posted", plugin.received.length === 0, plugin.received);
});

// 6. config submit requires an explicit, matching version.
await withPlugin({}, async (baseUrl) => {
  const noVersion = await runCli(["config", "submit", "--file", "data/rogue_config.json"], { baseUrl });
  check("submit without --version exits 2", noVersion.code === 2, noVersion.stderr);
  const stale = await runCli(["config", "submit", "--file", "data/rogue_config.json",
    "--version", "1"], { baseUrl });
  check("stale config version exits 4", stale.code === 4, stale.stderr);
  const invalid = await runCli(["config", "validate", "--file", "cli/tests/invalid-config.json"]);
  check("invalid config exits 2", invalid.code === 2, invalid.stderr);
  const valid = await runCli(["config", "validate", "--file", "data/rogue_config.json"]);
  check("valid config exits 0", valid.code === 0, valid.stderr);
  check("shipped config is still valid JSON",
    JSON.parse(readFileSync(join(ROOT, "data", "rogue_config.json"), "utf8")).StartPt > 0);
});

// 7. wait honours stage conditions and protocol mismatch surfaces.
await withPlugin({}, async (baseUrl) => {
  const ok = await runCli(["wait", "--stage", "Selecting", "--timeout", "5"], { baseUrl });
  check("wait on satisfied stage exits 0", ok.code === 0, ok.stderr);
  const bad = await runCli(["wait", "--stage", "Combat", "--timeout", "1"], { baseUrl });
  check("wait timeout exits 5", bad.code === 5, bad.stderr);
});
await withPlugin({ statePatch: () => ({ protocol: 3 }) }, async (baseUrl) => {
  const result = await runCli(["doctor", "--json"], { baseUrl });
  const report = JSON.parse(result.stdout);
  check("protocol mismatch fails doctor", result.code === 3 && report.ok === false, report.blockers);
  check("protocol mismatch names the Lua layer",
    report.blockers.some((b) => b.includes("Lua 协议")), report.blockers);
});

// 8. scenario runner: declarative steps, no arbitrary code.
await withPlugin({}, async (baseUrl) => {
  const file = join(ROOT, "cli", "tests", "scenario-ok.json");
  const result = await runCli(["scenario", "run", file, "--json"], { baseUrl });
  const report = JSON.parse(result.stdout);
  check("scenario passes", result.code === 0 && report.ok === true, report.steps);
  const bad = await runCli(["scenario", "run", join(ROOT, "cli", "tests", "scenario-fail.json"), "--json"], { baseUrl });
  check("failing scenario exits 4", bad.code === 4, bad.stdout.slice(0, 200));
});

// Return must wait for actual village/player readiness, not only an applied command.
await withPlugin({statePatch:s=>({ui:{scene:s.returnStarted?"village":"quest_reward"},preparation:{players:s.returnStarted?[{id:0}]:[]}})}, async(baseUrl,p)=>{
 const result=await runCli(["game","return","--timeout","2","--json"],{baseUrl});
 check("game return waits for village",result.code===5 && p.received.filter(x=>x.cmd==="returnToVillage").length===1,result.stdout);
});
await withPlugin({statePatch:s=>({ui:{scene:"village"},preparation:{players:[{id:0}]}})}, async(baseUrl,p)=>{
 const result=await runCli(["game","return","--json"],{baseUrl});
 check("game return already in village does not submit",result.code===0 && p.received.length===0,result.stdout);
});

let returningPlugin;
await withPlugin({statePatch:s=>({ui:{scene:returningPlugin?.received.some(x=>x.cmd==="returnToVillage")?"village":"quest_reward"},preparation:{players:[{id:0}]}})}, async(baseUrl,p)=>{
 returningPlugin=p;
 const result=await runCli(["game","return","--timeout","2","--json"],{baseUrl});
 check("game return completes after native state advances",result.code===0 && JSON.parse(result.stdout).scene==="village" && p.received.length===1,result.stdout);
});

// 9. Script control: reset, run-script content/path forms, timeout with error surfacing.
await withPlugin({}, async (baseUrl, plugin) => {
  const reset = await runCli(["game", "reset", "--json"], { baseUrl });
  check("game reset exits 0", reset.code === 0, reset.stderr);
  const sample = join(ROOT, "cli", "tests", "probe-sample.lua");
  const run = await runCli(["game", "run-script", sample, "--json"], { baseUrl });
  const runOut = JSON.parse(run.stdout);
  check("run-script uploads local content and returns PASS", run.code === 0 &&
    runOut.ok === true && runOut.report?.verdict === "PASS", run.stderr || run.stdout.slice(0, 200));
  check("run-script posted the content form", plugin.received.some((r) => r.endpoint === "script/run" &&
    r.payload?.name?.startsWith("exec-") && r.payload?.content?.includes("publish_probe")),
    JSON.stringify(plugin.received));
});
await withPlugin({ staleProbeFirst: true }, async (baseUrl, plugin) => {
 const sample = join(ROOT, "cli", "tests", "probe-sample.lua");
 const result = await runCli(["game", "run-script", sample, "--json"], { baseUrl });
 const body = JSON.parse(result.stdout);
 check("same-name stale probe is ignored until this execution reports", result.code === 0 &&
  body.report.executionId === plugin.state.scriptQueued.executionId && plugin.state.probeReads >= 2, result.stdout);
});
await withPlugin({ runReject: 404 }, async (baseUrl) => {
  const missing = await runCli(["game", "run-script", "reframework/autorun-probe/nope.lua", "--json"], { baseUrl });
  check("run-script path form 404 exits 4", missing.code === 4, missing.stderr);
});
await withPlugin({ noProbe: true,
  scriptError: { ok: true, available: true, hasError: true, error: "syntax error near 'end'" } },
async (baseUrl) => {
  const sample = join(ROOT, "cli", "tests", "probe-sample.lua");
  const result = await runCli(["game", "run-script", sample, "--timeout", "2", "--json"], { baseUrl });
  check("run-script without report exits 5 with framework error",
    result.code === 5 && result.stderr.includes("syntax error near 'end'"), result.stderr);
});
await withPlugin({ scriptUnavailable: true }, async (baseUrl) => {
  const reset = await runCli(["game", "reset", "--json"], { baseUrl });
  check("script API unavailable exits 3", reset.code === 3, reset.stderr);
});

await withPlugin({ noProbe: true }, async (baseUrl) => {
  const result = await runCli(["doctor", "--json", "--sample-ms", "30"], { baseUrl });
  const body = JSON.parse(result.stdout);
  check("player release is healthy without an automatic Lua probe", result.code === 0 && body.ok &&
    body.layers.lua.state === "unreported" && body.layers.business.state === "live", result.stdout);
});

await withPlugin({receiptPatch:()=>({targets:[0]}),statePatch:()=>({enemies:[
 {uid:0,dead:true,captured:false},{uid:100,dead:false,captured:false}
]})},async(baseUrl,plugin)=>{
 const result=await runCli(["test","kill-all","--json"],{baseUrl});
 const body=JSON.parse(result.stdout);
 check("kill certifies frozen targets without waiting for a newly spawned sequential enemy",result.code===0&&body.ok&&body.targets?.[0]===0&&plugin.received.length===1,result.stdout);
});
await withPlugin({},async(baseUrl,plugin)=>{
 const result=await runCli(["test","kill-all","--json"],{baseUrl});
 check("kill receipt without UID evidence is uncertain and never retried",result.code===6&&plugin.received.length===1,result.stderr);
});

console.log(failures === 0 ? "\nALL CLI CONTRACT CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
