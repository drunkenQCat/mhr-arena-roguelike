// Game identity and receipt waiting.
//
// A state snapshot is only acted on after reading fresh identity: bridgeId,
// questUnique, waveToken, configVersion. null is preserved as null — 0 would be
// a different task instance, not "no task".
import { getJson, getRaw, postCommand, newRequestId } from "./http.mjs";
import { EXIT, CliError, rejected, timeout, uncertain } from "./exit.mjs";

export const TERMINAL_STATUSES = ["applied", "rejected", "uncertain"];

/** Fields copied into every command so Lua can reject stale intents. */
export async function captureIdentity(baseUrl, timeoutMs) {
  const state = await getJson(baseUrl, "/api/state", timeoutMs);
  if (state.ok !== true) throw new CliError(EXIT.UNAVAILABLE, "状态不可用：Lua 未发布有效快照");
  const bridgeId = typeof state.bridgeId === "string" ? state.bridgeId : null;
  if (!bridgeId) throw new CliError(EXIT.UNAVAILABLE, "状态缺少 bridgeId，Lua 桥未就绪");
  return {
    state, bridgeId,
    questUnique: state.questUnique ?? null,
    waveToken: state.preparation?.waveToken ?? null,
    configVersion: state.configVersion ?? null,
    at: new Date().toISOString(),
  };
}

function findReceipt(packet, id) {
  if (!packet || typeof packet !== "object") return null;
  if (packet.last?.id === id) return packet.last;
  return packet.history?.find((entry) => entry?.id === id) ?? null;
}

/**
 * Poll /api/results for one request id.
 * - bridgeId change: the Lua generation is gone; the receipt cannot arrive here.
 * - `purchase`/`pending` commands treat `queued` as non-final.
 * Returns the terminal receipt; throws timeout (5) or uncertain (6).
 */
export async function waitForReceipt(baseUrl, id, bridgeId, options = {}) {
  const { timeoutMs = 15000, pollMs = 250, settleQueued = false, onPacket } = options;
  const deadline = Date.now() + timeoutMs;
  let lastSeen = null;
  let lastError = null;
  while (Date.now() < deadline) {
    let packet = null;
    try {
      packet = await getJson(baseUrl, "/api/results", Math.min(3000, timeoutMs));
    } catch (error) {
      lastError = error;
      if (error.code === EXIT.ERROR) throw error;
    }
    if (packet) {
      onPacket?.(packet);
      if (packet.bridgeId && bridgeId && packet.bridgeId !== bridgeId) {
        throw uncertain(`脚本会话已更换（${bridgeId} → ${packet.bridgeId}），未收到 ${id} 的确认。`,
          { requestId: id, bridgeId, currentBridgeId: packet.bridgeId, lastSeen });
      }
      const receipt = findReceipt(packet, id);
      if (receipt) {
        lastSeen = receipt;
        if (TERMINAL_STATUSES.includes(receipt.status) && !(settleQueued && receipt.status === "queued")) {
          return receipt;
        }
      }
    }
    await sleep(pollMs);
  }
  if (lastSeen) {
    throw uncertain(`${id} 在 ${timeoutMs}ms 内仍为 ${lastSeen.status}，结果未确定。`,
      { requestId: id, last: lastSeen });
  }
  const tail = lastError ? `（最后一次读取：${lastError.message}）` : "";
  throw timeout(`${timeoutMs}ms 内未收到 ${id} 的回执${tail}`, { requestId: id });
}

export function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

/**
 * Full submit protocol used by every mutation:
 *   fresh identity → unique id → POST → wait for terminal receipt.
 * Never retries automatically: uncertain results need a fresh read, not a resend.
 */
export async function submit(baseUrl, command, options = {}) {
  const { timeoutMs = 3000, receiptTimeoutMs = 15000, settleQueued = false, onProgress } = options;
  if (options.identity) {
    // Reuse an identity captured by the caller (scenario runner), but never send a
    // command without one: the Lua side rejects unknown bridgeIds anyway.
  }
  const identity = options.identity ?? await captureIdentity(baseUrl, timeoutMs);
  const id = newRequestId(command.cmd);
  onProgress?.(`提交 ${id}（${command.cmd}）@ 任务 ${identity.questUnique} / 波次 ${identity.waveToken}`);
  await postCommand(baseUrl, {
    ...command,
    id,
    bridgeId: identity.bridgeId,
    questUnique: identity.questUnique,
    waveToken: identity.waveToken,
    configVersion: identity.configVersion,
  }, timeoutMs);
  const receipt = await waitForReceipt(baseUrl, id, identity.bridgeId,
    { timeoutMs: receiptTimeoutMs, settleQueued, onPacket: options.onPacket });
  return { id, receipt, identity };
}

/** Maps a terminal receipt to the CLI exit code it deserves. */
export function receiptOutcome(receipt) {
  switch (receipt.status) {
    case "applied": return { code: EXIT.OK, receipt };
    case "rejected": return { code: EXIT.REJECTED, receipt };
    case "uncertain": return { code: EXIT.UNCERTAIN, receipt };
    default: return { code: EXIT.UNCERTAIN, receipt };
  }
}

export function requireReceipt(receipt) {
  const outcome = receiptOutcome(receipt);
  if (outcome.code === EXIT.OK) return receipt;
  const message = `${receipt.status}：${receipt.message ?? "(无消息)"}`;
  if (outcome.code === EXIT.REJECTED) throw rejected(message, { receipt });
  throw uncertain(message, { receipt });
}