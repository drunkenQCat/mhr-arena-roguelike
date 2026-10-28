// Declarative scenario runner: action / wait / assert steps only.
//
// No arbitrary JS or Lua is accepted. Waits are condition + deadline with a short
// poll interval, so "monsters should exist by now" never becomes "sleep 30s".
// A bridgeId change aborts the run: the identity the scenario captured is gone.
import { readFileSync, writeFileSync } from "node:fs";
import { EXIT, CliError, usage, rejected, timeout } from "./exit.mjs";
import { captureIdentity, submit, requireReceipt, sleep } from "./session.mjs";
import { readState } from "./observe.mjs";

const STEP_KINDS = new Set(["action", "wait", "assert"]);

function loadScenario(path) {
  let scenario;
  try { scenario = JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { throw usage(`场景文件无法解析：${path} (${error.message})`); }
  if (!scenario || typeof scenario !== "object" || !Array.isArray(scenario.steps)) {
    throw usage("场景需要 { name, steps: [...] } 结构");
  }
  scenario.steps.forEach((step, index) => {
    if (!STEP_KINDS.has(step.kind)) throw usage(`步骤 ${index + 1} 的 kind 必须是 action/wait/assert`);
    if (step.kind === "action" && typeof step.cmd !== "string") throw usage(`步骤 ${index + 1} 缺少 cmd`);
    if (step.kind !== "action" && typeof step.expect !== "string") {
      throw usage(`步骤 ${index + 1} 缺少 expect（如 stage=Selecting、layer>=2、uid.12.dead）`);
    }
  });
  return scenario;
}

/** Minimal predicate language over a state snapshot: `path op value`. */
export function parseExpect(expression) {
  const text = expression.trim();
  // Presence form: "bridgeId" / "questUnique!=" — true when the value exists.
  const presence = /^([a-zA-Z][\w.]*)\s*(!=)?$/.exec(text);
  if (presence) {
    const path = presence[1];
    return {
      label: text,
      test: (state) => {
        const value = readPath(state, path);
        return value !== undefined && value !== null && value !== "";
      },
    };
  }
  const match = /^([a-zA-Z][\w.]*)\s*(==|!=|>=|<=|>|<|=)\s*(.+)$/.exec(text);
  if (!match) throw usage(`无法解析条件：${expression}（形如 stage=Selecting、layer>=2、uid.12.dead）`);
  const [, path, operator, rawValue] = match;
  const value = rawValue === "null" ? null
    : rawValue === "true" ? true
      : rawValue === "false" ? false
        : /^-?\d+(\.\d+)?$/.test(rawValue) ? Number(rawValue)
          : rawValue;
  const test = (state) => {
    const actual = readPath(state, path);
    switch (operator) {
      case "=": case "==": return actual === value || String(actual) === String(value);
      case "!=": return !(actual === value || String(actual) === String(value));
      case ">=": return Number(actual) >= Number(value);
      case "<=": return Number(actual) <= Number(value);
      case ">": return Number(actual) > Number(value);
      case "<": return Number(actual) < Number(value);
      default: throw usage(`未知比较符 ${operator}`);
    }
  };
  return { label: expression, test };
}

export function readPath(state, path) {
  return path.split(".").reduce((current, key) =>
    (current === null || current === undefined ? undefined : current[key]), state);
}

async function waitUntil(baseUrl, predicate, { timeoutMs, bridgeId, timeoutMsPerRead }) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const result = await readState(baseUrl, { timeoutMs: timeoutMsPerRead });
    if (!result.ok) { await sleep(300); continue; }
    last = result.state;
    if (bridgeId && last.bridgeId !== bridgeId) {
      throw rejected(`脚本会话变化（${bridgeId} → ${last.bridgeId}）：场景条件基于旧代，已中止`);
    }
    if (predicate.test(last)) return last;
    await sleep(Math.min(500, Math.max(100, Math.floor(timeoutMs / 100))));
  }
  throw timeout(`条件未满足：${predicate.label}`, { last });
}

function identityFor(command, captured) {
  return {
    bridgeId: captured.bridgeId,
    questUnique: captured.questUnique,
    waveToken: captured.waveToken,
    configVersion: captured.configVersion,
    state: captured.state,
  };
}

export async function runScenario({ baseUrl, file, options, output }) {
  const scenario = loadScenario(file);
  const timeoutMs = (scenario.timeoutSeconds ?? 120) * 1000;
  const started = Date.now();
  const steps = [];
  const httpTimeoutMs = options.timeoutS * 1000;
  const receiptTimeoutMs = options.receiptTimeoutS * 1000;

  const first = await readState(baseUrl, { timeoutMs: httpTimeoutMs });
  if (!first.ok) throw new CliError(EXIT.UNAVAILABLE, `场景开始前状态不可用：${first.error}`);
  const captured = await captureIdentity(baseUrl, httpTimeoutMs);
  const bridgeId = captured.bridgeId;
  output.progress(`场景 ${scenario.name ?? file} 开始：bridge ${bridgeId} 任务 ${captured.questUnique} 波次 ${captured.waveToken}`);

  let failed = null;
  for (const [index, step] of scenario.steps.entries()) {
    const label = step.name ?? `${step.kind}#${index + 1}`;
    try {
      if (step.kind === "action") {
        const { id, receipt } = await submit(baseUrl, step.cmd === "startRun"
          ? { cmd: "startRun", armor: step.armor ?? captured.state.armorOptions?.[0] }
          : step.cmd === "choose" ? { cmd: "choose", index: step.index }
            : step.cmd === "buy" ? { cmd: "buy", itemId: step.itemId }
              : step.cmd === "setInvincible" ? { cmd: "setInvincible", value: step.value !== false }
                : step.cmd === "setRoute" ? { cmd: "setRoute", route: step.route }
                  : { cmd: step.cmd },
        { identity: identityFor(step, captured), timeoutMs: httpTimeoutMs, receiptTimeoutMs,
          settleQueued: step.settleQueued === true });
        requireReceipt(receipt);
        if (step.expect) await waitUntil(baseUrl, parseExpect(step.expect),
          { timeoutMs: step.timeoutSeconds ? step.timeoutSeconds * 1000 : timeoutMs, bridgeId, timeoutMsPerRead: httpTimeoutMs });
        // killAll is acknowledged as queued and settles on a later native frame; the
        // receipt is not the completion signal, an explicit wait step is.
        steps.push({ step: label, kind: "action", ok: true, requestId: id,
          status: receipt.status, completion: receipt.status === "queued" ? "awaiting-wait-step" : "terminal" });
      } else if (step.kind === "wait") {
        const state = await waitUntil(baseUrl, parseExpect(step.expect),
          { timeoutMs: step.timeoutSeconds ? step.timeoutSeconds * 1000 : timeoutMs, bridgeId, timeoutMsPerRead: httpTimeoutMs });
        steps.push({ step: label, kind: "wait", ok: true, expect: step.expect,
          observed: { sessionStage: state.sessionStage, layer: state.layer } });
      } else {
        const state = await readState(baseUrl, { timeoutMs: httpTimeoutMs });
        if (!state.ok) throw new CliError(EXIT.UNAVAILABLE, state.error);
        if (state.state.bridgeId !== bridgeId) {
          throw rejected(`脚本会话变化（${bridgeId} → ${state.state.bridgeId}）：旧断言失效`);
        }
        const predicate = parseExpect(step.expect);
        if (!predicate.test(state.state)) {
          steps.push({ step: label, kind: "assert", ok: false, expect: step.expect,
            observed: state.state });
          throw rejected(`断言不成立：${step.expect}`, { observed: state.state });
        }
        steps.push({ step: label, kind: "assert", ok: true, expect: step.expect });
      }
      output.progress(`PASS ${label}`);
    } catch (error) {
      failed = { step: label, index: index + 1, exitCode: error.code ?? EXIT.ERROR, error: error.message,
        detail: error.detail ?? null };
      steps.push({ step: label, kind: step.kind, ok: false, error: error.message });
      output.progress(`FAIL ${label}: ${error.message}`);
      break;
    }
  }

  const report = {
    ok: failed === null,
    scenario: scenario.name ?? file,
    file,
    baseUrl,
    bridgeId,
    startedAt: new Date(started).toISOString(),
    durationMs: Date.now() - started,
    steps,
    failure: failed,
  };
  if (options.report) writeFileSync(options.report, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  output.result(report, (value) => [
    `${value.ok ? "PASS" : "FAIL"} ${value.scenario} (${value.durationMs}ms)`,
    ...value.steps.map((s) => `${s.ok ? "  ok  " : "  fail"} ${s.step}${s.error ? `: ${s.error}` : ""}`),
  ].join("\n"));
  return failed ? (failed.exitCode ?? EXIT.ERROR) : EXIT.OK;
}