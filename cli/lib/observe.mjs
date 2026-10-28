// Read-only probes: doctor, state, probe, capabilities.
import { getRaw } from "./http.mjs";
import { EXIT } from "./exit.mjs";

/**
 * Layered health report. Each layer is independent: an HTTP-healthy DLL with no
 * Lua is "unavailable" for the business layer, not "down".
 *
 * Heartbeat liveness uses the local monotonic clock over bridgeId + counter. A
 * paused or unfocused game can legitimately stop publishing, so a stalled
 * heartbeat is reported as stalled (with its age), never as "process gone".
 */
export async function doctor(baseUrl, { timeoutMs = 3000, sampleMs = 1600, expectProtocol = 4 } = {}) {
  const report = {
    ok: false,
    baseUrl,
    layers: {
      http: { state: "down" },
      dll: { state: "unknown" },
      lua: { state: "unknown" },
      business: { state: "unknown" },
    },
    protocol: { expected: expectProtocol, actual: null, compatible: null },
    liveness: { state: "unknown" },
    blockers: [],
  };

  const probe = await getRaw(baseUrl, "/api/probe", timeoutMs);
  if (probe.status !== 200 || !probe.body) {
    report.layers.http = { state: "down", detail: probe.body?.error ?? `HTTP ${probe.status}` };
    report.blockers.push("DLL 未响应：确认游戏已启动且 webconsole.dll 在 reframework/plugins");
    return report;
  }
  report.layers.http = { state: "up", status: probe.status };
  const dll = probe.body;
  report.layers.dll = {
    state: "up",
    plugin: dll.plugin, version: dll.moduleVersion, pid: dll.pid,
    session: dll.session, uptimeMs: dll.uptimeMs, transport: dll.transport,
    luaSessions: dll.sessions, pings: dll.pings, commands: dll.commands,
    queuedCommands: dll.queuedCommands,
  };
  report.protocol.actual = dll.protocol ?? null;
  report.protocol.compatible = dll.protocol === expectProtocol;
  if (!report.protocol.compatible) {
    report.blockers.push(`DLL 协议 ${dll.protocol} 与 CLI 期望 ${expectProtocol} 不一致：更新 DLL/页面后重启游戏`);
  }

  const luaReport = await getRaw(baseUrl, "/api/probe/report", timeoutMs);
  report.layers.lua = luaReport.status === 200 && luaReport.body
    ? { state: luaReport.body.ok ? "pass" : "fail", moduleVersion: luaReport.body.moduleVersion,
        session: luaReport.body.session, at: luaReport.body.atIso,
        errors: luaReport.body.result?.errors ?? [] }
    : { state: "unreported", detail: luaReport.body?.error ?? `HTTP ${luaReport.status}` };

  // Business layer: two state reads separated by sampleMs. Compare counter picks
  // up a live heartbeat; an unchanged counter over the window is a stall, which
  // can be a paused game rather than a dead one.
  const first = await getRaw(baseUrl, "/api/state", timeoutMs);
  if (first.status !== 200 || !first.body) {
    report.layers.business = { state: "unavailable", detail: first.body?.error ?? `HTTP ${first.status}` };
    report.blockers.push("Lua 尚未发布业务状态：确认 autorun 已加载 mhw_rogue.lua 与探针");
    return report;
  }
  const started = performance.now();
  await new Promise((resolve) => setTimeout(resolve, sampleMs));
  const second = await getRaw(baseUrl, "/api/state", timeoutMs);
  const before = first.body, after = second.body ?? {};
  const advanced = after.counter !== undefined && before.counter !== undefined && after.counter !== before.counter;
  const sameBridge = after.bridgeId === before.bridgeId;
  report.liveness = {
    state: advanced ? "live" : "stalled",
    bridgeId: after.bridgeId ?? null,
    counter: { from: before.counter ?? null, to: after.counter ?? null },
    sampleWindowMs: Math.round(performance.now() - started),
  };
  if (!advanced && sameBridge) {
    report.liveness.hint = "计数器在采样窗口内未推进：游戏可能暂停、失焦或主循环卡住，不能据此判定进程已退出";
  }
  if (!sameBridge) {
    report.liveness.hint = "采样期间 bridgeId 变化：脚本刚重载，重新执行 doctor 获取稳定视图";
  }
  report.layers.business = {
    state: advanced ? "live" : "stalled",
    protocol: after.protocol ?? null,
    sessionStage: after.sessionStage ?? null,
    corePhase: after.corePhase ?? null,
    layer: after.layer ?? null,
    questUnique: after.questUnique ?? null,
    sampledAt: after.sampledAt ?? null,
  };
  if ((after.protocol ?? null) !== expectProtocol) {
    report.blockers.push(`Lua 协议 ${after.protocol} 与 CLI 期望 ${expectProtocol} 不一致：部署新 bundle 并 Reset scripts`);
  }
  report.ok = report.layers.http.state === "up" && report.layers.dll.state === "up" &&
    report.layers.lua.state === "pass" && report.layers.business.state === "live" &&
    report.protocol.compatible === true && (after.protocol ?? null) === expectProtocol;
  return report;
}

export async function readState(baseUrl, { timeoutMs = 3000 } = {}) {
  const { status, body } = await getRaw(baseUrl, "/api/state", timeoutMs);
  if (status !== 200 || !body) {
    return { ok: false, exitCode: EXIT.UNAVAILABLE, status,
      error: body?.error ?? `HTTP ${status}` };
  }
  return { ok: true, state: body };
}

export async function readProbe(baseUrl, { timeoutMs = 3000 } = {}) {
  const probe = await getRaw(baseUrl, "/api/probe", timeoutMs);
  if (probe.status !== 200 || !probe.body) {
    return { ok: false, exitCode: EXIT.UNAVAILABLE, error: probe.body?.error ?? `HTTP ${probe.status}` };
  }
  const report = await getRaw(baseUrl, "/api/probe/report", timeoutMs);
  return {
    ok: true,
    dll: probe.body,
    lua: report.status === 200 ? report.body : { ok: false, unreported: true,
      error: report.body?.error ?? `HTTP ${report.status}` },
  };
}

/**
 * Capability matrix derived from a state snapshot. Each entry is implemented
 * (the Lua side owns a handler) plus allowed right now, with the blocking reason.
 * This is observation only: `allowed` mirrors the same preconditions the command
 * handler enforces, so a CLI user can see why a command would be refused.
 */
export const COMMAND_CATALOGUE = [
  { cmd: "getConfig", writes: false, summary: "读取当前生效配置与版本" },
  { cmd: "submitConfig", writes: true, summary: "提交配置（需显式 configVersion）" },
  { cmd: "startRun", writes: true, summary: "开局（Idle/Finished/Fault 且村庄未接任务）" },
  { cmd: "choose", writes: true, summary: "选择下一波（需完成集结且无未决交易）" },
  { cmd: "buy", writes: true, summary: "购买/补满/服务（共用游戏内资格）" },
  { cmd: "setInvincible", writes: true, summary: "测试用无敌开关（单人测试任务）" },
  { cmd: "killAll", writes: true, summary: "请求击杀当前已出场怪物" },
  { cmd: "retryPost", writes: true, summary: "重试原生接取" },
  { cmd: "stop", writes: true, summary: "停止本局并恢复原生结算" },
  { cmd: "setRoute", writes: true, summary: "切换 inPlace/reentry（仅开局前）" },
];

export function capabilitiesFrom(state, dllProtocol) {
  const actions = [];
  const add = (name, implemented, allowed, reason) =>
    actions.push({ action: name, implemented, allowed, reason: reason ?? null });
  const stage = state?.sessionStage ?? null;
  const busy = state?.shopBusy === true;

  add("run.start", true, ["Idle", "Finished", "Fault"].includes(stage) && state?.capabilities?.start === true,
    state?.capabilities?.start ? null : `当前阶段 ${stage ?? "unknown"} 不允许开局`);
  add("run.choose", true, state?.capabilities?.choose === true && !busy,
    state?.capabilities?.choose ? (busy ? "商店交易进行中" : null) : "需完成清波与集结");
  add("run.stop", true, state?.capabilities?.stop === true, state?.capabilities?.stop ? null : "未开局");
  add("run.retry", true, ["AwaitQuest", "Fault"].includes(stage), "仅等待接取或故障阶段");
  add("run.route", true, ["Idle", "Finished", "Fault"].includes(stage), "路线只能在开局前切换");
  add("test.invincible", true, stage === "Combat", "仅战斗阶段（单人测试任务）");
  add("test.killAll", true, stage === "Combat", "仅战斗阶段");
  add("shop.buy", true, state?.shopAvailable === true && !busy && dllProtocol === 4,
    state?.shopAvailable ? (busy ? "商店交易进行中" : null) : (state?.shopReason ?? "当前不可购买"));
  const catalog = COMMAND_CATALOGUE.map((entry) => ({ ...entry, implemented: true }));
  const orders = [];
  if (dllProtocol !== 4) orders.push(`DLL 协议 ${dllProtocol} ≠ 4：CLI 写入命令可能被旧版 Lua 拒绝`);
  return {
    protocol: 4,
    dllProtocol: dllProtocol ?? null,
    commands: catalog,
    actions,
    orders,
    sessionStage: stage,
    note: "allowed 与 Lua 侧前置条件同源展示；最终以回执和状态后置条件为准。",
  };
}