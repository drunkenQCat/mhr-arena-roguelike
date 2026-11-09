#!/usr/bin/env node
// Agent-facing control CLI for the in-game webconsole plugin.
//
// Commands and exit codes are documented in docs/cli.md. Every mutation goes
// through the same submit protocol: fresh identity -> unique request id -> POST ->
// wait for a terminal receipt. Nothing here retries a command automatically.
import { scriptPayload, isExecutionReport } from "./lib/script-run.mjs";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EXIT, CliError, usage, unavailable, rejected } from "./lib/exit.mjs";
import { normalizeBaseUrl, getRaw, postJson } from "./lib/http.mjs";
import { captureIdentity, submit, requireReceipt, waitForReceipt, sleep } from "./lib/session.mjs";
import { doctor, readState, readProbe, capabilitiesFrom, COMMAND_CATALOGUE, uiSection } from "./lib/observe.mjs";
import { createOutput, runMain } from "./lib/output.mjs";
import { createValidator } from "./lib/config-validate.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PROTOCOL = 4;

const HELP = `用法: node cli/mhr.mjs <命令> [选项]

只读:
  doctor [--json] [--sample-ms N]        分层健康报告（HTTP/DLL/Lua/业务心跳）
  state [--json]                         当前业务快照
  probe [--json]                         DLL 身份 + Lua 探针报告
  capabilities [--json]                  命令/动作的 implemented 与 allowed
  ui [--json]                            视角/场景观察（原生界面分类，未识别即 unknown）
  shop list [--json] [--category X]      商店目录与购买资格
  config get [--json]                    读取当前生效配置

写入（提交后等待终态回执）:
  run start --armor <名称>               开局
  run choose --index <N>                 选择波次
  run route <inPlace|reentry>            切换路线（仅开局前）
  run retry                              重试原生接取
  run stop                               停止本局
  test invincible <on|off>               无敌开关
  test tp --to <origin|monster>          传送本机玩家；仅当前受控斗技场，可用于联机验证
  test kill-all                          请求击杀已出场怪物
  shop buy --item <商品ID>               购买/补满/服务
  config validate --file <路径>          本地校验（复用 src/core/config.ts）
  config submit --file <路径> --version <当前版本>

等待与场景:
  wait --stage <stage> [--layer N] [--quest-unique N] [--wave-token N]
       [--uid-alive N] [--uid-dead N] [--shop] [--timeout S]
  scenario run <文件.json> [--report <输出>]

原生菜单（需新版 Lua）:
  game enter --slot N --timeout 120       从支持的标题/弹窗加载现有存档进村
  title advance | title continue         原生标题操作
  saves list | saves load --slot N       观察/加载已有存档
  dialog close --token TOKEN             关闭已识别的连接错误
  wait --scene village --timeout 120     等待原生场景

脚本控制（需 fork 版框架 dinput8）:
  game return --timeout 120              继续结束任务的原生结算并等待回村
  game reset                             重置全部脚本（下一帧生效，epoch +1）
  game run-script <文件> [--timeout S]   执行一个 Lua 文件并等待其 publish_probe 报告；
                                         本地存在该文件则按内容上传，否则视为游戏目录相对路径
  game last-error                        读取框架记录的最近脚本错误文本

通用选项:
  --base-url URL     默认 http://127.0.0.1:11777（或 MHR_CLI_BASE_URL）
  --json             机器可读输出（stdout 单文档）
  --timeout S        HTTP 单次超时（默认 3）
  --receipt-timeout S 回执等待（默认 15）

退出码: 0 成功 / 1 内部错误 / 2 参数错误 / 3 未就绪或未支持 /
        4 前置条件或命令被拒绝 / 5 超时 / 6 结果不确定`;

function parseArgs(argv) {
  const words = [];
  const options = { json: false, baseUrl: undefined, timeoutS: 3, receiptTimeoutS: 15,
    sampleMs: 1600, armor: undefined, index: undefined, item: undefined, file: undefined,
    testLayer: undefined, players: undefined, as: undefined, requestId: undefined,
    version: undefined, stage: undefined, layer: undefined, questUnique: undefined,
    waveToken: undefined, uidAlive: [], uidDead: [], shop: false, timeout: undefined,
    report: undefined, category: undefined, probeTimeoutS: undefined };
  const valueFlags = {
    "--base-url": (v) => { options.baseUrl = v; },
    "--timeout": (v) => { options.timeoutS = Number(v); options.timeout = Number(v); },
    "--receipt-timeout": (v) => { options.receiptTimeoutS = Number(v); },
    "--sample-ms": (v) => { options.sampleMs = Number(v); },
    "--armor": (v) => { options.armor = v; },
    "--test-layer": (v) => { options.testLayer = Number(v); },
    "--players": (v) => { options.players = Number(v); },
    "--as": (v) => { options.as = v; },
    "--request-id": (v) => { options.requestId = v; },
    "--index": (v) => { options.index = Number(v); },
    "--item": (v) => { options.item = v; },
    "--file": (v) => { options.file = v; },
    "--version": (v) => { options.version = Number(v); },
    "--to": (v) => { options.to = v; },
    "--scene": (v) => { options.scene = v; },
    "--slot": (v) => { options.slot = Number(v); },
    "--token": (v) => { options.dialogToken = v; },
    "--stage": (v) => { options.stage = v; },
    "--layer": (v) => { options.layer = Number(v); },
    "--quest-unique": (v) => { options.questUnique = Number(v); },
    "--wave-token": (v) => { options.waveToken = Number(v); },
    "--uid-alive": (v) => { options.uidAlive.push(Number(v)); },
    "--uid-dead": (v) => { options.uidDead.push(Number(v)); },
    "--report": (v) => { options.report = v; },
    "--category": (v) => { options.category = v; },
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") { options.json = true; continue; }
    if (arg === "--shop") { options.shop = true; continue; }
    if (arg === "-h" || arg === "--help") { options.help = true; continue; }
    if (arg in valueFlags) {
      const value = argv[++i];
      if (value === undefined) throw usage(`${arg} 缺少参数值`);
      valueFlags[arg](value);
      continue;
    }
    if (arg.startsWith("--")) throw usage(`未知选项：${arg}`);
    words.push(arg);
  }
  for (const key of ["timeoutS", "receiptTimeoutS", "sampleMs"]) {
    if (!Number.isFinite(options[key]) || options[key] <= 0) throw usage(`选项 ${key} 必须是正数`);
  }
  return { words, options };
}

const fmt = (value) => value === null || value === undefined ? "—" : String(value);

/** Reads a JSON file, mapping IO/parse failures to exit 2 (bad input) not 1. */
function readJsonFile(path) {
  const absolute = resolve(path);
  let text;
  try { text = readFileSync(absolute, "utf8"); }
  catch { throw usage(`文件不可读：${absolute}`); }
  try { return JSON.parse(text); }
  catch (error) { throw usage(`JSON 解析失败：${absolute} (${error.message})`); }
}

function printDoctor(report) {
  const lines = [
    `HTTP   : ${report.layers.http.state}${report.layers.http.detail ? ` (${report.layers.http.detail})` : ""}`,
    `DLL    : ${report.layers.dll.state} ${fmt(report.layers.dll.version)} pid=${fmt(report.layers.dll.pid)} session=${fmt(report.layers.dll.session)}`,
    `Lua    : ${report.layers.lua.state}${report.layers.lua.moduleVersion ? ` module=${report.layers.lua.moduleVersion}` : ""}${report.layers.lua.detail ? ` (${report.layers.lua.detail})` : ""}`,
    `业务   : ${report.layers.business.state} stage=${fmt(report.layers.business.sessionStage)} layer=${fmt(report.layers.business.layer)} quest=${fmt(report.layers.business.questUnique)}`,
    `心跳   : ${report.liveness.state} counter ${fmt(report.liveness.counter?.from)}→${fmt(report.liveness.counter?.to)} (${fmt(report.liveness.sampleWindowMs)}ms)`,
    `协议   : DLL ${fmt(report.protocol.actual)} / Lua ${fmt(report.layers.business.protocol)} / 期望 ${report.protocol.expected}`,
  ];
  if (report.liveness.hint) lines.push(`提示   : ${report.liveness.hint}`);
  for (const blocker of report.blockers) lines.push(`阻塞   : ${blocker}`);
  return `${report.ok ? "PASS" : "FAIL"}\n${lines.join("\n")}`;
}

async function main() {
  const { words, options } = parseArgs(process.argv.slice(2));
  const output = createOutput({ json: options.json });
  if (options.help || words.length === 0) {
    process.stdout.write(`${HELP}\n`);
    return options.help ? EXIT.OK : EXIT.USAGE;
  }
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const timeoutMs = options.timeoutS * 1000;
  const receiptTimeoutMs = options.receiptTimeoutS * 1000;
  const [group, sub] = words;

  const snapshot = async () => {
    const result = await readState(baseUrl, { timeoutMs });
    if (!result.ok) throw unavailable(result.error);
    return result.state;
  };

  switch (group) {
    case "game": {
      if (sub === "launch") {
        const { launchGame } = await import("./lib/game-process.mjs");
        output.result(await launchGame(baseUrl)); return EXIT.OK;
      }
      if (sub === "reset") {
        const { status, body } = await postJson(baseUrl, "/api/script/reset", {}, timeoutMs * 1000);
        if (status !== 200) {
          throw new CliError(status === 503 ? EXIT.UNAVAILABLE : EXIT.REJECTED,
            `重置请求失败：${body?.error ?? `HTTP ${status}`}`, { status, body });
        }
        output.result(body, (v) => `已请求重置脚本（下一帧生效，epoch ${v.epoch}）；旧 bridgeId 的请求将被拒绝`);
        return EXIT.OK;
      }
      if (sub === "return") {
        const identity = await captureIdentity(baseUrl, timeoutMs);
        if (identity.state.ui?.scene === "village" && (identity.state.preparation?.players?.length ?? 0) > 0) { output.result({ok:true, scene:"village"}); return EXIT.OK; }
        const result = await submit(baseUrl, {cmd:"returnToVillage"}, {identity, timeoutMs, receiptTimeoutMs});
        requireReceipt(result.receipt);
        const deadline = performance.now() + (options.timeout ?? 120) * 1000;
        let last;
        while (performance.now() < deadline) {
          const current = await captureIdentity(baseUrl, Math.min(timeoutMs,3000));
          if (current.bridgeId !== identity.bridgeId) throw rejected("回村期间脚本会话改变");
          last = current.state.ui;
          if (last?.scene === "village" && (current.state.preparation?.players?.length ?? 0) > 0) {
            output.result({ok:true, scene:"village", receipt:result.receipt}); return EXIT.OK;
          }
          if (last?.returnFlow?.state === "stopped") throw rejected(last.returnFlow.message, {ui:last});
          await sleep(500);
        }
        throw new CliError(EXIT.TIMEOUT,"原生回村未完成；请查看结算状态",{ui:last});
      }
      if (sub === "last-error") {
        const { status, body } = await getRaw(baseUrl, "/api/script/error", timeoutMs * 1000);
        if (status !== 200 || !body) throw unavailable(`HTTP ${status}`);
        output.result(body, (v) => v.hasError ? `最近脚本错误：
${v.error}` : "没有记录的脚本错误");
        return EXIT.OK;
      }
      if (sub === "run-script") {
        const file = words[2];
        if (!file) throw usage("用法: game run-script <本地文件或游戏目录相对路径> [--timeout S]");
        let content = null;
        try { content = readFileSync(resolve(file), "utf8"); } catch { content = null; }
        let execution;
        try { execution = scriptPayload(file.replaceAll("\\", "/"), content); }
        catch (error) { throw usage(`Lua preflight: ${error.message}`); }
        const { script, executionId, payload } = execution;
        const submitted = await postJson(baseUrl, "/api/script/run", payload, timeoutMs * 1000);
        if (submitted.status !== 200) {
          const { status, body } = submitted;
          throw new CliError(status === 503 ? EXIT.UNAVAILABLE : EXIT.REJECTED,
            `run-script 被拒绝：${body?.error ?? `HTTP ${status}`}`, { status, body });
        }
        const queuedEpoch = submitted.body.epoch;
        const waitS = options.timeout ?? 15;
        const deadline = Date.now() + waitS * 1000;
        let report = null;
        while (Date.now() < deadline) {
          await sleep(500);
          const probe = await getRaw(baseUrl, "/api/probe/report", timeoutMs * 1000);
          // 探针契约：报告自带 script 与 epoch；两者都对上才认定是本轮触发的结果。
          if (probe.status === 200 && probe.body &&
              isExecutionReport(probe.body, script, queuedEpoch, executionId)) {
            report = probe.body;
            break;
          }
        }
        if (!report) {
          const err = await getRaw(baseUrl, "/api/script/error", timeoutMs * 1000);
          const detail = err.body?.hasError
            ? `框架记录了脚本错误：${err.body.error}`
            : "脚本未发布报告（可能仍在排队，或加载阶段即失败）";
          throw new CliError(EXIT.TIMEOUT, `等待 ${waitS}s 未收到 ${script} 的报告。${detail}`,
            { script, queuedEpoch, executionId, lastError: err.body ?? null });
        }
        const ok = report.verdict === "PASS";
        output.result({ ok, report },
          (v) => `${script}: ${v.report.verdict}${v.report.error ? ` — ${v.report.error.split("\n")[0]}` : ""}`);
        return ok ? EXIT.OK : EXIT.REJECTED;
      }
      if (sub !== "enter") throw usage("当前支持 game launch / enter / return / reset / run-script / last-error");
      const { enterGame } = await import("./lib/game-entry.mjs");
      const result = await enterGame(baseUrl, options, output.progress);
      output.result(result); return EXIT.OK;
    }
    case "title": case "startup": case "saves": case "dialog": {
      if (group === "saves" && sub === "list") {
        const state = await snapshot(); output.result({ ui: state.ui, slots: state.ui?.slots ?? [] }); return EXIT.OK;
      }
      const cmd = group === "title" && ["advance", "continue"].includes(sub) ? `title.${sub}`
        : group === "startup" && sub === "acknowledge" ? "startup.acknowledge"
        : group === "saves" && sub === "load" ? "save.load"
        : group === "dialog" && sub === "close" ? "dialog.close" : null;
      if (!cmd) throw usage("未知 UI 操作");
      const { uiCommand } = await import("./lib/game-entry.mjs");
      const receipt = await uiCommand(baseUrl, cmd, options, { slot: options.slot, dialogToken: options.dialogToken });
      output.result({ ok: true, receipt }); return EXIT.OK;
    }
    case "doctor": {
      const report = await doctor(baseUrl, { timeoutMs, sampleMs: options.sampleMs, expectProtocol: PROTOCOL });
      output.result(report, printDoctor);
      return report.ok ? EXIT.OK : EXIT.UNAVAILABLE;
    }
    case "state": {
      const state = await snapshot();
      output.result(state, (value) => [
        `阶段   : ${fmt(value.sessionStage)} / 核心 ${fmt(value.corePhase)}`,
        `层数   : ${fmt(value.layer)}   PT ${fmt(value.pt)}   猫车 ${fmt(value.cartsLeft)}/${fmt(value.maxCarts)}`,
        `任务   : ${fmt(value.questId)} / 实例 ${fmt(value.questUnique)}   波次 ${fmt(value.preparation?.waveToken)}`,
        `桥     : ${fmt(value.bridgeId)}   协议 ${fmt(value.protocol)}   配置 v${fmt(value.configVersion)}`,
        `消息   : ${fmt(value.message)}`,
      ].join("\n"));
      return EXIT.OK;
    }
    case "probe": {
      const report = await readProbe(baseUrl, { timeoutMs });
      if (!report.ok) throw unavailable(report.error);
      output.result(report, (value) => [
        `DLL    : ${fmt(value.dll.moduleVersion)} protocol=${fmt(value.dll.protocol)} pid=${fmt(value.dll.pid)} session=${fmt(value.dll.session)}`,
        `计数   : sessions=${fmt(value.dll.sessions)} pings=${fmt(value.dll.pings)} commands=${fmt(value.dll.commands)} queued=${fmt(value.dll.queuedCommands)}`,
        `探针   : ${value.lua.ok ? "PASS" : value.lua.unreported ? "未上报" : "FAIL"} ${fmt(value.lua.session)} ${fmt(value.lua.atIso)}`,
      ].join("\n"));
      return report.lua.ok === true ? EXIT.OK : EXIT.UNAVAILABLE;
    }
    case "ui": {
      const state = await snapshot();
      const ui = uiSection(state);
      output.result(ui, (value) => [
        `场景   : ${fmt(value.scene)}   token ${fmt(value.sceneToken)}`,
        `地图   : ${fmt(value.mapNo)}   加载中 ${fmt(value.loading)}   忙碌 ${fmt(value.busy)}`,
        `弹窗   : ${value.dialogsKnown === false ? "未观察（该能力未实现）" : `${(value.dialogs ?? []).length} 个`}`,
        `可操作 : ${(value.allowedActions ?? []).join(", ") || "—"}`,
        `证据   : ${(value.evidence ?? []).map((e) => `${e.source}=${JSON.stringify(e.value)}`).join("; ")}`,
        ...(value.reason ? [`说明   : ${value.reason}`] : []),
      ].join("\n"));
      return EXIT.OK;
    }
    case "capabilities": {
      const state = await snapshot();
      const dll = await getRaw(baseUrl, "/api/probe", timeoutMs);
      const matrix = capabilitiesFrom(state, dll.body?.protocol ?? null);
      output.result(matrix, (value) => value.actions
        .map((a) => `${a.allowed ? "OK  " : "NO  "} ${a.action}${a.reason ? ` — ${a.reason}` : ""}`).join("\n"));
      return EXIT.OK;
    }
    case "shop": {
      const state = await snapshot();
      if (sub === "list") {
        const listing = state.shop ?? {};
        const categories = options.category ? [options.category] : Object.keys(listing);
        const rows = categories.flatMap((category) => (listing[category] ?? []).map((entry) => ({ category, ...entry })));
        output.result({ ok: true, available: state.shopAvailable === true,
          reason: state.shopReason ?? null, busy: state.shopBusy === true, items: rows },
        (value) => [
          `商店   : ${value.available ? "可购买" : "不可购买"}${value.reason ? ` — ${value.reason}` : ""}${value.busy ? "（交易中）" : ""}`,
          ...value.items.map((entry) => `${entry.canBuy ? "OK  " : "NO  "} [${entry.category}] ${entry.id} ${entry.name} ${entry.price}PT ${entry.mode === "service" ? "" : `${entry.owned}/${entry.cap}`}${entry.reason ? ` — ${entry.reason}` : ""}`),
        ].join("\n"));
        return EXIT.OK;
      }
      if (sub === "buy") {
        if (!options.item) throw usage("shop buy 需要 --item <商品ID>");
        const identity = await captureIdentity(baseUrl, timeoutMs);
        const listing = identity.state.shop ?? {};
        const entry = Object.values(listing).flat().find((item) => item.id === options.item);
        if (!entry) throw usage(`商店没有商品 ${options.item}（先运行 shop list）`);
        if (entry.canBuy !== true) throw rejected(`${options.item} 当前不可购买：${entry.reason ?? "资格不足"}`);
        output.progress(`商品 ${entry.name} 价格 ${entry.price} PT，持有 ${entry.owned}/${entry.cap}`);
        const { id, receipt } = await submit(baseUrl, { cmd: "buy", itemId: options.item },
          { identity, timeoutMs, receiptTimeoutMs, settleQueued: true });
        output.progress(`回执 ${id}: ${receipt.status}`);
        requireReceipt(receipt);
        // Purchase receipts are re-published after the native delivery result, so an
        // `applied` receipt here is the trade conclusion, not just the queue ack.
        const after = await snapshot();
        const afterItem = Object.values(after.shop ?? {}).flat().find((item) => item.id === options.item);
        output.result({ ok: true, receipt, before: { owned: entry.owned, pt: identity.state.pt },
          after: { owned: afterItem?.owned ?? null, pt: after.pt ?? null } },
        (value) => `已购买 ${options.item}：${value.receipt.message ?? ""}\n持有 ${value.before.owned} → ${fmt(value.after.owned)}，PT ${value.before.pt} → ${fmt(value.after.pt)}`);
        return EXIT.OK;
      }
      throw usage(`未知 shop 子命令：${fmt(sub)}`);
    }
    case "run": {
      const identity = await captureIdentity(baseUrl, timeoutMs);
      const send = async (command, label) => {
        if (command.cmd === "startRun" && options.armor &&
            !(identity.state.armorOptions ?? []).includes(options.armor)) {
          throw usage(`未知护甲 ${options.armor}；可选：${(identity.state.armorOptions ?? []).join(", ")}`);
        }
        if (command.cmd === "startRun" && options.testLayer !== undefined) {
          command.testLayer = options.testLayer;
        }
        if (command.cmd === "choose" && !Number.isInteger(options.index)) throw usage("run choose 需要 --index");
        const { id, receipt } = await submit(baseUrl, command, { identity, timeoutMs, receiptTimeoutMs });
        output.progress(`回执 ${id}: ${receipt.status}`);
        requireReceipt(receipt);
        output.result({ ok: true, command, receipt },
          (value) => `${label}: ${value.receipt.message ?? "applied"}`);
        return EXIT.OK;
      };
      if (sub === "start") {
        return send({ cmd: "startRun", armor: options.armor ?? identity.state.armorOptions?.[0] },
          `开局 ${options.armor ?? identity.state.armorOptions?.[0] ?? ""}`);
      }
      if (sub === "choose") return send({ cmd: "choose", index: options.index }, `选择波次 ${options.index}`);
      if (sub === "retry") return send({ cmd: "retryPost" }, "重试接取");
      if (sub === "stop") return send({ cmd: "stop" }, "停止本局");
      if (sub === "route") {
        const route = words[2];
        if (route !== "inPlace" && route !== "reentry") throw usage("run route 需要 inPlace 或 reentry");
        return send({ cmd: "setRoute", route }, `路线 ${route}`);
      }
      throw usage(`未知 run 子命令：${fmt(sub)}`);
    }
    case "test": {
      const identity = await captureIdentity(baseUrl, timeoutMs);
      if (sub === "invincible") {
        const value = words[2];
        if (value !== "on" && value !== "off") throw usage("test invincible 需要 on 或 off");
        const { id, receipt } = await submit(baseUrl, { cmd: "setInvincible", value: value === "on" },
          { identity, timeoutMs, receiptTimeoutMs });
        output.progress(`回执 ${id}: ${receipt.status}`);
        requireReceipt(receipt);
        output.result({ ok: true, invincible: value === "on", receipt },
          () => `无敌 ${value === "on" ? "已开" : "已关"}：${receipt.message ?? ""}`);
        return EXIT.OK;
      }
      if (sub === "tp") {
        if (!["origin", "monster"].includes(options.to)) throw usage("test tp requires --to origin or monster");
        const { receipt } = await submit(baseUrl, { cmd: "teleport", to: options.to },
          { identity, timeoutMs, receiptTimeoutMs });
        requireReceipt(receipt);
        const target = receipt.target;
        if (!target || ![target.x, target.y, target.z].every(Number.isFinite)) throw unavailable("Lua did not return a finite TP target");
        // Arrival can be followed immediately by a faint. The terminal receipt
        // retains the authoritative local-player observation from that frame.
        const observed = receipt.position;
        if (observed && Number.isFinite(receipt.verifiedAt) && [observed.x, observed.y, observed.z].every(Number.isFinite) &&
            Math.hypot(observed.x-target.x, observed.y-target.y, observed.z-target.z) <= 5) {
          output.result({ok:true,receipt,target,position:observed,verified:true}); return EXIT.OK;
        }
        // The warp flow fades out, moves and fades in; arrival lands ~4s after the kick.
        const deadline = Date.now() + 10000;
        let position = null;
        while (Date.now() < deadline) {
          await sleep(250);
          const state = await snapshot();
          if (state.bridgeId !== identity.bridgeId || state.questUnique !== receipt.questUnique) throw rejected("TP session changed; no retry");
          const prep = state.preparation;
          position = prep?.localPlayerId != null ? prep.players?.find(p => p.id === prep.localPlayerId)?.position
            : !state.online ? prep?.players?.[0]?.position : null;
          if (position && [position.x, position.y, position.z].every(Number.isFinite) &&
            Math.hypot(position.x-target.x, position.y-target.y, position.z-target.z) <= 5) {
            output.result({ ok: true, receipt, target, position, verified: true }); return EXIT.OK;
          }
        }
        output.result({ ok: false, receipt, target, position, verified: false }); return EXIT.TIMEOUT;
      }
      if (sub === "party") {
        const op = words[2];
        const send2 = async (command, label) => {
          const { id, receipt } = await submit(baseUrl, command, { identity, timeoutMs, receiptTimeoutMs });
          output.progress(`Receipt ${id}: ${receipt.status}`);
          requireReceipt(receipt);
          output.result({ ok: receipt.status === "applied", label, receipt, businessParty: receipt.businessParty ?? null },
            (v) => `${label}: ${v.receipt.message ?? "applied"}`);
          return EXIT.OK;
        };
        if (op === "create") {
          const n = options.players ?? 1;
          return send2({ cmd: "party", sub: "create", mockPlayers: n }, `Party session established (host + ${n} mock players)`);
        }
        if (op === "buy") {
          if (!options.as || !options.item) throw usage("test party buy requires --as <playerId> --item <item ID> [--request-id <id>]");
          const id = options.requestId ?? `party-${options.as}-${Date.now()}`;
          return send2({ cmd: "party", sub: "buy", playerId: options.as, itemId: options.item, id },
            `${options.as} purchase ${options.item} (requestId=${id})`);
        }
        if (op === "state") {
          return send2({ cmd: "party", sub: "state", playerId: options.as ?? undefined },
            `Party state${options.as ? ` (${options.as} view)` : " (full view)"}`);
        }
        if (op === "reset") return send2({ cmd: "party", sub: "reset" }, "Party session invalidated");
        throw usage("test party create|buy|state|reset");
      }
      if (sub === "kill-all") {
        // killAll is acknowledged as queued; the native kill happens on a later frame.
        // Waiting for a second receipt never terminates, so require an observable
        // post-condition instead of claiming success from the queue ack.
        const { id, receipt } = await submit(baseUrl, { cmd: "killAll" },
          { identity, timeoutMs, receiptTimeoutMs });
        output.progress(`回执 ${id}: ${receipt.status}`);
        requireReceipt(receipt);
        const deadline = Date.now() + 10000;
        let last = identity.state;
        while (Date.now() < deadline) {
          await sleep(250);
          const state = await snapshot();
          last = state;
          const enemies = state.enemies ?? [];
          if (enemies.length > 0 && enemies.every((enemy) => enemy.dead || enemy.captured)) break;
        }
        const enemies = last.enemies ?? [];
        const allDown = enemies.length > 0 && enemies.every((enemy) => enemy.dead || enemy.captured);
        output.result({ ok: allDown, receipt, enemies: enemies.map((enemy) => ({ uid: enemy.uid, dead: enemy.dead, captured: enemy.captured })) },
          (value) => `击杀请求已执行；在场 ${value.enemies.length} 只，${allDown ? "全部死亡/捕获" : "仍有存活"}`);
        return allDown ? EXIT.OK : EXIT.TIMEOUT;
      }
      throw usage(`未知 test 子命令：${fmt(sub)}`);
    }
    case "config": {
      if (sub === "get") {
        const identity = await captureIdentity(baseUrl, timeoutMs);
        const { receipt } = await submit(baseUrl, { cmd: "getConfig" }, { identity, timeoutMs, receiptTimeoutMs });
        requireReceipt(receipt);
        output.result({ ok: true, configVersion: receipt.configVersion, config: receipt.config,
          activeRules: receipt.activeRules }, (value) => JSON.stringify(value.config, null, 2));
        return EXIT.OK;
      }
      if (sub === "validate") {
        if (!options.file) throw usage("config validate 需要 --file");
        const raw = readJsonFile(options.file);
        const validator = createValidator(ROOT);
        const config = await validator.validate(raw);
        output.result({ ok: true, path: resolve(options.file), quest: config.quest,
          armorOptions: config.armorOptions }, (value) => `本地校验通过：${value.path}（任务 ${value.quest.id}）`);
        return EXIT.OK;
      }
      if (sub === "submit") {
        if (!options.file) throw usage("config submit 需要 --file");
        if (!Number.isInteger(options.version)) throw usage("config submit 需要 --version <当前版本>（来自 config get / state）");
        const raw = readJsonFile(options.file);
        const validator = createValidator(ROOT);
        await validator.validate(raw); // local shape check first; Lua still re-validates
        const identity = await captureIdentity(baseUrl, timeoutMs);
        if (identity.configVersion !== options.version) {
          throw rejected(`配置版本已变化（${identity.configVersion} ≠ ${options.version}）：请重新载入后再合并`);
        }
        const { id, receipt } = await submit(baseUrl, { cmd: "submitConfig", config: raw,
          configVersion: options.version }, { identity, timeoutMs, receiptTimeoutMs:Math.max(receiptTimeoutMs,200000),settleQueued:true });
        output.progress(`回执 ${id}: ${receipt.status}`);
        requireReceipt(receipt);
        output.result({ ok: true, receipt }, () => `已提交：v${receipt.configVersion} ${receipt.message ?? ""}`);
        return EXIT.OK;
      }
      throw usage(`未知 config 子命令：${fmt(sub)}`);
    }
    case "wait": {
      const conditions = buildWaitConditions(options, words.slice(1));
      const deadline = Date.now() + (options.timeout ?? 120) * 1000;
      const startedBridge = (await readState(baseUrl, { timeoutMs })).state?.bridgeId ?? null;
      let last = null;
      while (Date.now() < deadline) {
        const state = await snapshot();
        last = state;
        if (startedBridge && state.bridgeId !== startedBridge) {
          throw rejected(`等待期间脚本会话变化（${startedBridge} → ${state.bridgeId}）：旧条件已失效`);
        }
        const unmet = conditions.filter((condition) => !condition.test(state));
        if (unmet.length === 0) {
          output.result({ ok: true, waitedMs: Date.now() - (deadline - (options.timeout ?? 120) * 1000),
            state: summarise(state) }, (value) => `满足：${value.waitedMs}ms 内条件成立`);
          return EXIT.OK;
        }
        await sleep(500);
      }
      const unmet = conditions.filter((condition) => !condition.test(last));
      throw new CliError(EXIT.TIMEOUT,
        `等待超时，未满足：${unmet.map((c) => c.label).join("；")}`,
        { last: summarise(last), unmet: unmet.map((c) => c.label) });
    }
    case "scenario":
      if (sub === "run") {
        const file = words[2];
        if (!file) throw usage("scenario run 需要场景文件路径");
        const { runScenario } = await import("./lib/scenario.mjs");
        return runScenario({ baseUrl, file: resolve(file), options, output, root: ROOT });
      }
      throw usage(`未知 scenario 子命令：${fmt(sub)}`);
    default:
      throw usage(`未知命令：${group}`);
  }
}

function summarise(state) {
  if (!state) return null;
  return {
    bridgeId: state.bridgeId, sessionStage: state.sessionStage, corePhase: state.corePhase,
    layer: state.layer, pt: state.pt, questUnique: state.questUnique,
    waveToken: state.preparation?.waveToken ?? null,
    enemies: (state.enemies ?? []).map((e) => ({ uid: e.uid, dead: e.dead, captured: e.captured })),
    shopAvailable: state.shopAvailable ?? null,
  };
}

/** --stage/--layer/... map to explicit predicates; unknown options are rejected above. */
function buildWaitConditions(options, trailing) {
  const conditions = [];
  if (options.scene) conditions.push({ label: `scene=${options.scene}`, test: s => s?.ui?.scene === options.scene });
  if (options.stage) conditions.push({ label: `stage=${options.stage}`,
    test: (s) => s.sessionStage === options.stage });
  if (Number.isFinite(options.layer)) conditions.push({ label: `layer=${options.layer}`,
    test: (s) => s.layer === options.layer });
  if (Number.isFinite(options.questUnique)) conditions.push({ label: `questUnique=${options.questUnique}`,
    test: (s) => s.questUnique === options.questUnique });
  if (Number.isFinite(options.waveToken)) conditions.push({ label: `waveToken=${options.waveToken}`,
    test: (s) => (s.preparation?.waveToken ?? null) === options.waveToken });
  for (const uid of options.uidAlive) conditions.push({ label: `uid ${uid} alive`,
    test: (s) => (s.enemies ?? []).some((e) => e.uid === uid && !e.dead && !e.captured) });
  for (const uid of options.uidDead) conditions.push({ label: `uid ${uid} dead`,
    test: (s) => (s.enemies ?? []).some((e) => e.uid === uid && (e.dead || e.captured)) });
  if (options.shop) conditions.push({ label: "shopAvailable", test: (s) => s.shopAvailable === true });
  if (conditions.length === 0) throw usage(`wait 需要至少一个条件（--stage/--layer/--uid-alive/--uid-dead/--shop）`);
  return conditions;
}

// Output must exist before main() so a thrown CliError still prints a JSON body.
// Exit through process.exitCode rather than process.exit(): the game endpoint is a
// Windows socket and libuv aborts when handles are torn down mid-close.
const early = parseArgsSafely(process.argv.slice(2));
process.exitCode = await runMain(main, createOutput({ json: early }));

function parseArgsSafely(argv) {
  try { return parseArgs(argv).options.json; } catch { return argv.includes("--json"); }
}
