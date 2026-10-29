// HTTP transport to the webconsole plugin.
//
// Every request carries a hard timeout so a hung game cannot wedge the CLI.
// GET failures are classified: refusing connection (server down) vs HTTP status
// vs body-level failure, because the three mean different things to `doctor`.
import { CliError, EXIT, unavailable } from "./exit.mjs";

export const DEFAULT_BASE_URL = process.env.MHR_CLI_BASE_URL || "http://127.0.0.1:11777";

export function normalizeBaseUrl(raw) {
  if (!raw) return DEFAULT_BASE_URL;
  let url;
  try { url = new URL(raw); } catch { throw unavailable(`无效的 --base-url：${raw}`); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw unavailable(`--base-url 必须是 http(s)：${raw}`);
  return url.origin;
}

/** True when the endpoint describes a game process on this machine. */
export function isLocalBaseUrl(baseUrl) {
  const host = new URL(baseUrl).hostname.replace(/^\[|\]$/g, "");
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

// Node's fetch keeps sockets in a pool; an unclosed keep-alive connection makes
// libuv abort at exit ("!(handle->flags & UV_HANDLE_CLOSING)"). Every request is
// short-lived, so closing is both correct and cheap.
const CLOSE_HEADERS = { Connection: "close" };

async function request(baseUrl, path, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(new URL(path, baseUrl), {
      ...init,
      headers: { ...CLOSE_HEADERS, ...(init.headers ?? {}) },
      signal: controller.signal,
    });
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = null; }
    return { status: response.status, body, text };
  } catch (error) {
    if (error?.name === "AbortError") throw unavailable(`${path} 在 ${timeoutMs}ms 内未响应`);
    throw unavailable(`${path} 连接失败：${error?.cause?.code ?? error?.message ?? error}`);
  } finally {
    clearTimeout(timer);
  }
}

/** GET returning {status, body}; never throws on HTTP status, only on transport failure. */
export async function getRaw(baseUrl, path, timeoutMs = 3000) {
  return request(baseUrl, path, { method: "GET" }, timeoutMs);
}

/** GET that treats any non-2xx body as an error with the HTTP status attached. */
export async function getJson(baseUrl, path, timeoutMs = 3000) {
  const { status, body, text } = await getRaw(baseUrl, path, timeoutMs);
  if (status >= 200 && status < 300 && body) return body;
  const message = body?.error ? `${body.error} (HTTP ${status})` : `HTTP ${status}: ${text.slice(0, 200)}`;
  throw new CliError(status === 503 ? EXIT.UNAVAILABLE : EXIT.ERROR, message, { status, body });
}

function newRequestId(prefix = "cli") {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return `${prefix}-${Date.now().toString(36)}-${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * POST /api/command. Returns the request id.
 * Throws `uncertain` when the server may have accepted the command: transport
 * failure after sending, 5xx, or a 2xx body that does not say queued.
 * Throws `rejected` for definitive 4xx refusals (403/413/415/429).
 */
export async function postCommand(baseUrl, command, timeoutMs = 3000) {
  const id = command.id ?? newRequestId();
  let result;
  try {
    result = await request(baseUrl, "/api/command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...command, id }),
    }, timeoutMs);
  } catch (error) {
    throw new CliError(EXIT.UNCERTAIN,
      `提交 ${id} 时连接中断：无法证明命令未执行，请先用同一 ID 查询。`,
      { requestId: id, cause: error.message });
  }
  const { status, body } = result;
  if (status >= 500) {
    throw new CliError(EXIT.UNCERTAIN, `提交 ${id} 得到 HTTP ${status}：可能已入队。`,
      { requestId: id, status });
  }
  if (status >= 400) {
    const message = body?.error ?? `HTTP ${status}`;
    throw new CliError(EXIT.REJECTED, `命令 ${id} 被拒绝：${message}`, { requestId: id, status, body });
  }
  if (body?.queued !== true) {
    throw new CliError(EXIT.UNCERTAIN, `命令 ${id} 响应未确认入队：${JSON.stringify(body)}`,
      { requestId: id, status, body });
  }
  return id;
}

export { newRequestId };
/**
 * POST an arbitrary JSON payload to a plugin endpoint (/api/script/*).
 * Returns the raw {status, body, text}; the caller maps statuses to exit codes,
 * because these endpoints are fire-and-forget queues rather than the command
 * receipt protocol.
 */
export async function postJson(baseUrl, path, payload, timeoutMs = 3000) {
  return request(baseUrl, path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }, timeoutMs);
}
