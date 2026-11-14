export interface RunSummary {layer:number;clearedWaves:number;earnedPt:number;spentPt:number;balance:number;remainingCarts:number;cartRestored:boolean;armor:string|null;durationSeconds:number;restored:boolean;reason:string;purchases:string[]|null;role:string|null;
  maxCarts?:number;
  ending?:{intent:'cleared-all'|'carts-exhausted'|'stopped'|'fault'|'native-ended'|'quest-left'|'entry-cancelled'|null;
    native:{questId:number;unique:number;status:'success'|'failed'|'return';deaths:number|null;observedAt:number;conflictingStatus?:'success'|'failed'}|null};
}
export interface ShopEntry { id: string; name: string; category: string; price: number; cap: number; owned: number; mode: string; desc?: string; canBuy: boolean; reason?: string; }
export interface Choice { index: number; label: string; monsters: string[]; mode?: string; hpMul: number; dmgMul: number; rewardPt: number; }
export interface RunEquipmentInventory { version:string; canEdit:boolean; reason:string|null; items:{key:number;id:number;name:string;position:number;worn:boolean;inherited:boolean;slotLevels:number[]|null;sockets:number[]|null}[]|null; jewels:{id:number;name:string;level:number;count:number;available:number}[]|null }
export interface ConsoleState {
  economy?:{totalPt:number;availablePt:number;reservedPt:number};
  nativePreparation?:{state:string;pending:boolean;reason:string;held:number;identity:{id:number;unique:number}|null};
  designerEffects?: import('./EffectShop.vue').EffectSnapshot | null;
  equipment?:RunEquipmentInventory;
  ui?: { scene: string; sceneToken?: string; resultNode?: string | null;
    dialogs?: { token: string; kind: string; text: string; passive?: boolean; supported: boolean; buttons?: string[] | null }[] | null;
    returnFlow?: { state: "waiting" | "complete" | "stopped"; message: string } | null };
  multiplayerEntry?: { armor?: string; armorOptions?: string[]; prepared?: boolean; role: string; host: number | null; self: number | null; questId: number;
    mode: string | null; hash: string | null; revision: number | null;
    transport: string; posting: boolean; canPost: boolean; message: string;
    sync: { available: boolean; reason: string; lobby: string | null; applied: boolean;
      members: { id: string; self: boolean; ready: boolean }[] | null };
    activeQuest: number | null; playing: boolean; canPrepare: boolean; nativeQuestPlayerCount: number | null;
    options: { index: number; mode: string; label: string }[] | null };
  multiplayerRun?: { role: "host" | "guest"; live: boolean; message: string; lobby: string; session: string;
    configSync?:{busy:boolean;host:boolean;message:string;serial:number|null;phase:string|null;result:{serial:number;status:string;message:string}|null}|null;
    members: { id: string; self: boolean; ready: boolean }[] | null; token: number | null;
    staged: { token: number; ordinal: number; type: number; slot: number; id: number; uid: number } | null;
    commit: boolean; fixedPartySize?: number } | null;
  runSummary?: RunSummary | null;
  previousRun?: RunSummary | null;
  supplyLoot?: {itemId:string;count:number;actual:number;granted:boolean;reason?:string}[] | null;
  testMode?: boolean;
  ok: boolean; protocol: 4; bridgeId: string; counter: number; publishedAt?: number;
  sampledAt?: number; configVersion: number; sessionStage: string; corePhase: string; questId: number | null;
  questUnique: number | null; layer: number; pt: number; cartsLeft: number; maxCarts: number;
  armor: string | null; armorOptions?: string[]; invincible: boolean; route?: string;
  killedUltimates?: string[] | null; activeWave: string | null; message: string; runtimeStatus?: string;
  choices: Choice[] | null; shop: Record<string, ShopEntry[]> | null;
  shopAvailable?: boolean; shopReason?: string; shopNotice?: string; shopBusy: boolean;
  preparation?: { localPlayerId?: number | null; waveToken: number | null; seen: number; resolved: number; expected: number;
    camp: { x: number; y: number; z: number } | null; radius: number; gathered: boolean;
    carveRemaining: number; dwellRemaining: number;
    players: { id: number; position: { x: number; y: number; z: number }; campDistance: number | null }[] | null };
  capabilities?: { start: boolean; choose: boolean; stop: boolean; route?: boolean; retry?: boolean;
    invincible?: boolean; kill?: boolean; teleport?: boolean; teleportMonster?: boolean; testLayer?: boolean };
  online?: boolean;
  control?: { ready: boolean; configRecovery?:string|null;nextRoute: string; configuredRoute: string; startReason: string | null;
    startup: { prepared: boolean; restorePending: boolean; message: string | null };
    startupRules: { keepPlayerWeapon: boolean; stripTalismans: boolean; stripInsect: boolean; weaponId: number | null } | null;
    armorSets: Record<string, { series: number; desc?: string }>;
    testLayers: number[] | null; activeWave: (Choice & { token: number; layer: number; monsterIds: number[] }) | null;
    testMessage: string; effectPending: boolean };
  services?: { buffs: { pending: { atk: number; def: number; crit: number }; active: { atk: number; def: number; crit: number };
    layer: number | null; critBonus: number; nativeCritical?: {base: number; result: number} | null } | null; lastTransaction: (Pick<CommandResult, "status" | "message"> & {retiredAfterRestore?:boolean}) | null;
    cartRestoreUsed: boolean; purchases: string[] | null };
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
  purchase?: boolean; effect?: boolean; effectOrder?:boolean;configuration?:boolean; alive?: () => boolean; onPacket?: (packet: ReceiptPacket) => void;
} = {}): Promise<CommandResult> {
  const deadline = performance.now() + (options.configuration?200000:options.effectOrder?60000:options.effect ? 20000 : 12000);
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
      const result = packet.last?.id === id ? packet.last : null;
      if (result && ["applied", "rejected", "uncertain", "queued"].includes(result.status) &&
        !((options.purchase || options.effect||options.effectOrder||options.configuration) && result.status === "queued")) return result;
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
