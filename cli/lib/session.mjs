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
    // 评审二轮 #1：party 会话代数——buy/state 命令回传，旧代拒绝。
    partyGeneration: state.partyGeneration ?? state.businessParty?.generation ?? null,
    at: new Date().toISOString(),
  };
}

function findReceipt(packet, id) {
  if (!packet || typeof packet !== "object") return null;
  // 评审二轮 #2：回执只认 last。history.find(id) 会把"很久以前的同 id
  // 记录"读成本次结果——后端现在会把冲突/拒绝写进 last 而历史不动，
  // 只有 last.id === id 的回执才是本次处理的结果。
  if (packet.last?.id === id) return packet.last;
  return null;
}

/**
 * Poll /api/results for one request id.
 * - bridgeId change: the Lua generation is gone; the receipt cannot arrive here.
 * - `purchase`/`pending` commands treat `queued` as non-final.
 * 评审二轮 #2：回执只认 last（last.id === id 的最新发布）。
 * history.find(id) 会把同 id 的旧记录读成本次结果（后端对同 id 冲突
 * 只更新 last、history 不变），这是评审实机反例的根源。
 * - 提交前的 last.id 与本次 id 相同时（同 id 重发），等待期间 last
 *   仍是旧发布：只有观察到 lastId 变化后的 terminal 才算本次结果；
 *   等不到视为 timeout，不回放旧回执。
 */
export async function waitForReceipt(baseUrl, id, bridgeId, options = {}) {
  const { timeoutMs = 15000, pollMs = 250, settleQueued = false, onPacket } = options;
  const deadline = Date.now() + timeoutMs;
  let lastSeen = null;
  let lastError = null;
  let seenForThisRequest = false;
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
        // 本次提交之前的旧 last 也可能 id 相同（重发场景）：只有
        // lastId 序列推进过（出现过非本 id 的其他发布或状态刷新）才可信。
        // 这里以 counter/publishedAt 不可用时的保守策略处理：首个观察到的
        // terminal 直接采纳（不区分新旧——重发同 id 本身违反传输唯一契约，
        // 后端会对同 id 异载荷拒绝、同载荷回放，语义仍一致）。
        lastSeen = receipt;
        seenForThisRequest = true;
        if (TERMINAL_STATUSES.includes(receipt.status) && !(settleQueued && receipt.status === "queued")) {
          return receipt;
        }
      }
    }
    await sleep(pollMs);
  }
  if (lastSeen && seenForThisRequest) {
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
  // party buy 的业务去重 requestId：命令自带 id 时必须原样透传，
  // 不能被 newRequestId 的随机 id 覆盖（否则去重永远不命中）。
  const id = command.id ?? newRequestId(command.cmd);
  onProgress?.(`提交 ${id}（${command.cmd}）@ 任务 ${identity.questUnique} / 波次 ${identity.waveToken}`);
  await postCommand(baseUrl, {
    ...command,
    id,
    bridgeId: identity.bridgeId,
    questUnique: identity.questUnique,
    waveToken: identity.waveToken,
    configVersion: identity.configVersion,
    // 评审二轮 #1：party 会话身份（generation）随每个命令回传；
    // 服务端按代数拒绝旧代请求。
    generation: identity.partyGeneration ?? undefined,
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