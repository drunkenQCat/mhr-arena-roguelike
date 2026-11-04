/** Native battle networking stays with Rise; Steam lobby metadata carries only entry plans. */
import { canonical } from "./wire_canonical";
import type { RogueConfig } from "../core/config";
import { makeQuestPlan, type MonsterCatalog } from "../core/quest_plan";
import type { WaveOption } from "../core/run_state";
import { QuestInstaller } from "./quest_installer";
import { QuestTransport } from "./quest_transport";
import { clockSeconds, getSingleton, loadWebconsole, questManager, rejson,
  type NativeWebconsole, type REManagedObject } from "./sdk";

export const ENTRY_QUEST_ID = 900103;
const modes = ["single", "sequential", "simultaneous"] as const;
type SteamSnapshot = NonNullable<ReturnType<NonNullable<NativeWebconsole["steam_snapshot"]>>>;
type Lobby = SteamSnapshot["lobbies"][number];
interface Plan { schema: 2; session: string; revision: number; owner: string; lobby: string;
  index: number; hash: string; rules: string; intent: "prepare" | "post"; }
function nullableIndex(lobby: REManagedObject, method: string): number | null {
  const value = lobby.call(method) as REManagedObject | null;
  if (!value || value.get_field("_HasValue") !== true) return null;
  const index = value.get_field("_Value") as number;
  return Number.isInteger(index) && index >= 0 && index < 4 ? index : null;
}
export function readLobbyIdentity(): { host: number | null; self: number | null; role: string } {
  try {
    const lobby = getSingleton("snow.LobbyManager");
    if (!lobby) return { host: null, self: null, role: "unavailable" };
    const host = nullableIndex(lobby, "getHostIndex"), self = nullableIndex(lobby, "getMyLobbyIndex");
    return { host, self, role: host === null || self === null ? "offline" : host === self ? "host" : "guest" };
  } catch { return { host: null, self: null, role: "unavailable" }; }
}
function key(plan: Plan): string {
  return `${plan.schema}|${plan.lobby}|${plan.owner}|${plan.session}|${plan.revision}|${plan.index}|${plan.hash}|${plan.rules}|${plan.intent}`;
}
function decode(text: string, lobby: Lobby): Plan | null {
  if (!text || text.length > 2048) return null;
  try {
    const p = rejson.load_string(text) as Plan | null;
    return p?.schema === 2 && p.owner === lobby.owner && p.lobby === lobby.id &&
      typeof p.session === "string" && p.session.length > 0 && p.session.length < 128 &&
      Number.isInteger(p.revision) && p.revision > 0 && Number.isInteger(p.index) && p.index >= 0 && p.index < 3 &&
      typeof p.hash === "string" && p.hash.length === 64 && typeof p.rules === "string" && p.rules.length === 64 && (p.intent === "prepare" || p.intent === "post") ? p : null;
  } catch { return null; }
}
function bridge(): NativeWebconsole | null { try { return loadWebconsole(); } catch { return null; } }

export class MultiplayerEntry {
  private installer: QuestInstaller | null = null;
  private transport: QuestTransport | null = null;
  private plan: Plan | null = null;
  private wire = "";
  private applied = "";
  private attempted = "";
  private initialized: string[] = [];
  private revision = 0;
  private lastPoll = -1;
  private pendingPost = false;
  private deadline = 0;
  private steam: SteamSnapshot = { available: false, reason: "等待 Steam 桥接", lobbies: [] };
  private lobby: Lobby | null = null;
  private message = "进入同一个在线大厅后，由大厅房主选波；队友自动同步。";
  private readonly session = `${clockSeconds()}-${Math.floor(Math.random() * 0xffffffff).toString(16)}`;
  constructor(private readonly config: RogueConfig, private readonly catalog: MonsterCatalog,
    private readonly canPrepare: () => boolean, private readonly network = bridge()) {}

  private requireIdle(): void {
    if (!this.canPrepare()) throw new Error("请先结束单人局并等待装备、背包恢复。");
    if (questManager()?.call("isActiveQuest") !== false) throw new Error("请先取消或完成当前已承接任务。");
    if (this.pendingPost || this.transport?.isActive()) throw new Error("正在确认或承接任务，请等待。");
  }
  private prepare(index: number): string {
    if (this.config.quest.baseId !== 603 || this.config.quest.mapNo !== 10) throw new Error("联机实验仅支持模板603 / 斗技场10。");
    const mode = modes[index];
    if (!mode) throw new Error("无效的联机选项。");
    const cfg = { ...this.config, quest: { ...this.config.quest, id: ENTRY_QUEST_ID } };
    const wave: WaveOption = { index, mode, typeTag: "MP-ENTRY", label: `联机入场 / ${mode}`,
      monsters: mode === "single" ? ["Great Izuchi"] : ["Great Izuchi", "Great Baggi"],
      tier: "weak", hpMul: 1, dmgMul: 1, rewardMul: 0, rewardPt: 0 };
    const plan = makeQuestPlan(cfg, this.catalog, wave, 1, 1, mode === "sequential");
    if (!this.installer) this.installer = new QuestInstaller(cfg, plan, true);
    this.installer.publish(plan, false);
    return this.digest();
  }
  private rulesDigest(): string {
    const hash = this.network?.steam_digest?.(canonical({ rules:this.config, runtimeProtocol:4 })) ?? "";
    if (hash.length !== 64) throw new Error("Cannot hash multiplayer rules");
    return hash;
  }
  private digest(): string {
    const hash = this.network?.steam_digest?.(this.installer!.multiplayerDescriptor()) ?? "";
    if (hash.length !== 64) throw new Error("原生任务表 SHA256 计算失败；需更新 webconsole.dll。");
    return hash;
  }
  private refresh(): void {
    const n = this.network;
    this.steam = n?.steam_snapshot && n.steam_plan && n.steam_ack && n.steam_digest
      ? n.steam_snapshot() : { available: false, reason: "需要 webconsole.dll 0.4.0；更新 DLL 后重启游戏。", lobbies: [] };
    if (!this.steam.lobbies) this.steam.lobbies = [];
    for (const l of this.steam.lobbies) if (!l.members) l.members = [];
    const role = readLobbyIdentity().role;
    if (this.lobby) {
      const current = this.steam.lobbies.find((l) => l.id === this.lobby!.id && l.owner === this.lobby!.owner);
      if (!current || (role !== "host" && role !== "guest")) this.invalidate("大厅或房主已变化，请重新选波。");
      else this.lobby = current;
    }
    if (role === "host" && this.canPrepare() && questManager()?.call("isActiveQuest") === false) {
      for (const l of this.steam.lobbies.filter((l) => l.owner === l.self)) {
        const context = `${l.id}|${l.owner}`;
        if (!this.initialized.includes(context)) {
          // New Lua session invalidates the owner's previous plan; never adopt it from Steam.
          if (!this.network!.steam_plan!(l.id, "")) throw new Error("无法清除旧大厅计划。");
          this.initialized.push(context); l.plan = "";
        }
      }
    }
  }
  private invalidate(message: string): void {
    this.pendingPost = false; this.transport?.cancel();
    this.plan = null; this.lobby = null; this.applied = ""; this.attempted = ""; this.wire = "";
    this.message = message;
  }
  private acknowledged(lobby: Lobby, plan: Plan): boolean {
    return lobby.members.length >= 2 && lobby.members.some((m) => m.id === lobby.self) &&
      lobby.members.every((m) => m.ack === key(plan));
  }
  private publish(plan: Plan): void {
    const wire = rejson.dump_string(plan, -1);
    if (!this.network?.steam_plan?.(plan.lobby, wire)) throw new Error("Steam 拒绝发布波次；大厅身份可能已变化。");
    this.plan = plan; this.wire = wire; this.applied = key(plan);
    if (!this.network.steam_ack?.(plan.lobby, this.applied)) throw new Error("本机准备回执提交失败。");
  }
  choose(index: number): void {
    this.requireIdle(); this.refresh();
    if (readLobbyIdentity().role !== "host") throw new Error("仅原生在线大厅房主可以选择怪物。");
    if (!Number.isInteger(index) || index < 0 || index > 2) throw new Error("无效的联机选项。");
    const candidates = this.steam.lobbies.filter((l) => l.owner === l.self);
    if (!this.steam.available || candidates.length !== 1) throw new Error(this.steam.reason || "无法唯一确定当前 Steam 大厅；请退出后重建大厅。");
    this.lobby = candidates[0]!;
    // Invalidate previous ACKs before local table mutation, including a failed preparation.
    if (!this.network!.steam_plan!(this.lobby.id, "")) throw new Error("无法撤销旧计划。");
    this.plan = null; this.applied = "";
    const hash = this.prepare(index);
    this.publish({ schema: 2, session: this.session, revision: ++this.revision,
      owner: this.lobby.owner, lobby: this.lobby.id, index, hash, rules: this.rulesDigest(), intent: "prepare" });
    this.message = "已通过 Steam 发布波次，等待所有队友自动准备并确认相同任务表。";
  }
  post(): void {
    this.requireIdle(); this.refresh();
    if (readLobbyIdentity().role !== "host" || !this.lobby || this.lobby.owner !== this.lobby.self ||
        !this.plan || this.lobby.plan !== this.wire || !this.acknowledged(this.lobby, this.plan))
      throw new Error("至少两名真实大厅成员必须全部确认相同任务表后才能承接。");
    if (this.digest() !== this.plan.hash) throw new Error("本机任务表已变化，请重新选波。");
    // Fresh revision is a second barrier: cached prepare ACKs cannot authorize posting.
    this.publish({ ...this.plan, revision: ++this.revision, intent: "post" });
    this.pendingPost = true; this.deadline = clockSeconds() + 20;
    this.message = "等待全队重新确认本次承接；确认齐全后打开原生柜台，不自动出发。";
  }
  retrySync(): void { this.requireIdle(); this.attempted = ""; this.applied = ""; }
  tick(): void {
    // Native counter needs per-frame ticking; Steam data and table readbacks do not.
    if (this.transport?.isActive()) {
      if (readLobbyIdentity().role !== "host") { this.invalidate("房主身份改变，停止承接。"); return; }
      this.transport.tick();
      if (this.transport.getError()) this.message = this.transport.getError()!;
    }
    const now = clockSeconds();
    if (this.lastPoll === now) return;
    this.lastPoll = now;
    try {
      this.refresh();
      const role = readLobbyIdentity().role;
      if (role === "guest") {
        const candidates = this.steam.lobbies.filter((l) => !!decode(l.plan, l));
        if (candidates.length !== 1) return;
        const lobby = candidates[0]!, plan = decode(lobby.plan, lobby)!;
        const identity = key(plan);
        if (this.attempted === identity) return;
        this.attempted = identity; this.lobby = lobby; this.plan = plan;
        if (!this.canPrepare() || questManager()?.call("isActiveQuest") !== false) {
          this.network!.steam_ack!(lobby.id, "not-ready"); this.applied = "";
          this.message = "已收到房主波次；请先取消任务、结束单人局并恢复装备，再重试同步。"; return;
        }
        this.network!.steam_ack!(lobby.id, "preparing"); this.applied = "";
        if (this.rulesDigest() !== plan.rules) throw new Error("房主与本机配置不一致，请全队同步配置后重试");
        const hash = this.prepare(plan.index);
        if (hash !== plan.hash) throw new Error("两端原生任务表哈希不一致，请确认游戏及模组版本相同。");
        if (!this.network!.steam_ack!(lobby.id, identity)) throw new Error("Steam 准备回执提交失败。");
        this.applied = identity;
        this.message = "已自动准备并核对相同任务表；等房主承接后，从原生任务板加入。";
      } else if (role === "host" && this.pendingPost) {
        if (now > this.deadline || !this.canPrepare() || questManager()?.call("isActiveQuest") !== false) {
          this.pendingPost = false; this.message = "承接确认超时或现场变化，未打开柜台；请确认队友状态后重试。"; return;
        }
        if (this.lobby && this.plan && this.lobby.plan === this.wire && this.acknowledged(this.lobby, this.plan)) {
          this.pendingPost = false;
          if (this.digest() !== this.plan.hash) throw new Error("本机任务表已变化，未承接。");
          if (!this.transport) this.transport = new QuestTransport(() => this.installer?.getQuest() ?? null, 60);
          this.transport.request(ENTRY_QUEST_ID, true);
          this.message = "全队已确认，正在承接。等队友在原生任务板加入，再手动出发。";
        }
      }
    } catch (error) {
      this.pendingPost = false;
      if (this.lobby && readLobbyIdentity().role === "guest") this.network?.steam_ack?.(this.lobby.id, "error");
      this.message = String(error);
    }
  }
  shutdown(): void { this.transport?.cancel(false); }
  hostTestEntry(): { installer: QuestInstaller; plan: import("../core/quest_plan").QuestPlan } | null {
    const plan = this.installer?.getPlan();
    return readLobbyIdentity().role === "host" && questManager()?.call("get_ActiveQuestNo") === ENTRY_QUEST_ID && plan && this.installer
      ? { installer: this.installer, plan } : null;
  }
  runEntry(): { installer: QuestInstaller; plan: import("../core/quest_plan").QuestPlan;
    lobby: string; owner: string; self: string; session: string; members: string[] } | null {
    const p = this.installer?.getPlan(), l = this.lobby;
    if (!p || !this.installer || !this.plan || this.plan.intent !== "post" || !l ||
        this.applied !== key(this.plan) || questManager()?.call("get_ActiveQuestNo") !== ENTRY_QUEST_ID) return null;
    const role = readLobbyIdentity().role;
    if (role !== "host" && role !== "guest") return null;
    return { installer: this.installer, plan: p, lobby: l.id, owner: l.owner, self: l.self,
      session: this.plan.session, members: l.members.map(m => m.id).sort() };
  }
  snapshot(): Record<string, unknown> {
    const identity = readLobbyIdentity(), qm = questManager(), lobby = this.lobby;
    const ready = !!lobby && !!this.plan && lobby.plan === this.wire && this.acknowledged(lobby, this.plan);
    return { ...identity, questId: ENTRY_QUEST_ID, mode: this.plan ? modes[this.plan.index] : null,
      hash: this.plan?.hash ?? null, revision: this.plan?.revision ?? null,
      transport: this.transport?.getStatus() ?? "Idle", nativePost: this.transport?.getDiagnostics() ?? null, posting: this.pendingPost || !!this.transport?.isActive(),
      canPost: ready && identity.role === "host" && !this.pendingPost && !this.transport?.isActive(),
      sync: { available: this.steam.available, reason: this.steam.reason, lobby: lobby?.id ?? null,
        applied: !!this.plan && this.applied === key(this.plan),
        members: lobby?.members.map((m) => ({ id: m.id, self: m.id === lobby.self,
          ready: !!this.plan && m.ack === key(this.plan) })) ?? [] },
      message: this.message, activeQuest: qm?.call("get_ActiveQuestNo") ?? null,
      playing: qm?.call("isPlayQuest") ?? false,
      nativeQuestPlayerCount: getSingleton("snow.LobbyManager")?.get_field("currentQuestPlayerCount") ?? null,
      canPrepare: this.canPrepare(), options: modes.map((mode, index) => ({ index, mode,
        label: mode === "single" ? "单怪：镰鼬龙王" : mode === "sequential" ? "顺序：镰鼬龙王 → 眠狗龙王" : "同时：镰鼬龙王 + 眠狗龙王" })),
      scope: "native-entry-experiment", verifiedTwoClients: false };
  }
}
