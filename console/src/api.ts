export interface ShopEntry { id: string; name: string; category: string; price: number; cap: number; owned: number; mode: string; desc?: string; canBuy: boolean; reason?: string; }
export interface Choice { index: number; label: string; monsters: string[]; mode?: string; hpMul: number; dmgMul: number; rewardPt: number; }
export interface ConsoleState {
  testMode?: boolean;
  ok: boolean; protocol: 4; bridgeId: string; counter: number; publishedAt?: number;
  sampledAt?: number; configVersion: number; sessionStage: string; corePhase: string; questId: number | null;
  questUnique: number | null; layer: number; pt: number; cartsLeft: number; maxCarts: number;
  armor: string | null; armorOptions?: string[]; invincible: boolean; route?: string;
  activeWave: string | null; message: string; runtimeStatus?: string;
  choices: Choice[] | null; shop: Record<string, ShopEntry[]> | null;
  shopAvailable?: boolean; shopReason?: string; shopNotice?: string; shopBusy: boolean;
  preparation?: { waveToken: number | null; seen: number; resolved: number; expected: number;
    camp: { x: number; y: number; z: number } | null; radius: number; gathered: boolean;
    carveRemaining: number; dwellRemaining: number;
    players: { id: number; position: { x: number; y: number; z: number }; campDistance: number | null }[] | null };
  capabilities?: { start: boolean; choose: boolean; stop: boolean };
  enemies?: { uid: number; typeId: number; dead: boolean; captured: boolean }[] | null;
}
/** GET /api/probe: DLL identity. Answering proves the native plugin is loaded, not that Lua runs. */
export interface ProbeInfo {
  ok: boolean; plugin: string; module: string; export: string; moduleVersion: string;
  protocol: number; pid: number; session: string; uptimeMs: number; sessions: number;
  stateSeq: number; queuedCommands: number; commands: number; pings: number; transport: string;
}

export interface CommandResult { id: string; status: string; message?: string; config?: unknown; activeConfig?: unknown; configVersion?: number; }
export interface ReceiptPacket { bridgeId?: string; last?: CommandResult; history?: CommandResult[] | null; }

export class HttpError extends Error {
  constructor(readonly status: number) { super(`服务返回 ${status}`); }
}

/** A transport failure after POST cannot establish that the game did not receive it. */
export class SubmissionUncertain extends Error {
  constructor(readonly requestId: string) { super("提交确认中断，继续查询同一请求；不会自动重发操作"); }
}

/** Only changes to the game's heartbeat count as a live connection. HTTP success is insufficient. */
export class Freshness {
  private key = "";
  private changed = -Infinity;
  observe(state: ConsoleState, now: number): void {
    const key = `${state.bridgeId}:${state.counter}`;
    if (key !== this.key) { this.key = key; this.changed = now; }
  }
  stale(now: number): boolean { return now - this.changed > 4000; }
}

export async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const r = await fetch(path, { cache: "no-store", signal });
  if (!r.ok) throw new HttpError(r.status);
  return await r.json() as T;
}

export async function postCommand(state: ConsoleState, cmd: string, extra: Record<string, unknown> = {}): Promise<string> {
  // LAN HTTP is not a secure context: randomUUID may be absent, getRandomValues is available.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const id = `web-${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
  let r: Response;
  try { r = await fetch("/api/command", { method: "POST", signal: AbortSignal.timeout(3000), headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, bridgeId: state.bridgeId, questUnique: state.questUnique,
      waveToken: state.preparation?.waveToken ?? null, configVersion: state.configVersion, cmd, ...extra }) });
  } catch { throw new SubmissionUncertain(id); }
  if (r.status >= 500) throw new SubmissionUncertain(id);
  if (!r.ok) throw new HttpError(r.status);
  let result;
  try { result = await r.json(); } catch { throw new SubmissionUncertain(id); }
  if (!result || result.ok !== true || result.queued !== true) throw new SubmissionUncertain(id);
  return id;
}

export async function waitForReceipt(id: string, bridge: string, options: {
  purchase?: boolean; alive?: () => boolean; onPacket?: (packet: ReceiptPacket) => void;
} = {}): Promise<CommandResult> {
  const deadline = performance.now() + 12000;
  while ((options.alive?.() ?? true) && performance.now() < deadline) {
    let packet: ReceiptPacket | null = null;
    try { packet = await getJson<ReceiptPacket>("/api/results", AbortSignal.timeout(3000)); }
    catch (error) {
      // Lua writes a small JSON file on another thread's read boundary. A partial
      // read or brief 503 is not evidence of a rejected or unexecuted purchase.
      if (error instanceof HttpError && [401, 403, 404].includes(error.status)) throw error;
    }
    if (packet?.bridgeId) {
      if (packet.bridgeId !== bridge) throw new Error("脚本会话已更换，未确认操作不会自动重发");
      options.onPacket?.(packet);
      const result = packet.last?.id === id ? packet.last : packet.history?.find((r) => r.id === id);
      if (result && ["applied", "rejected", "uncertain", "queued"].includes(result.status) &&
        !(options.purchase && result.status === "queued")) return result;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`游戏未在时限内确认请求 ${id}；结果不明，请先检查当前状态，不要重复购买`);
}

export function downloadJson(name: string, value: unknown): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }));
  const a = document.createElement("a"); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
