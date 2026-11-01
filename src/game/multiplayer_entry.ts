/** Bounded native lobby entry experiment, separate from solo progression and mock parties. */
import type { RogueConfig } from "../core/config";
import { makeQuestPlan, type MonsterCatalog } from "../core/quest_plan";
import type { WaveOption } from "../core/run_state";
import { QuestInstaller } from "./quest_installer";
import { QuestTransport } from "./quest_transport";
import { getSingleton, questManager, type REManagedObject } from "./sdk";

export const ENTRY_QUEST_ID = 900103;
export const ENTRY_CODES = ["MHR-ENTRY-1-S", "MHR-ENTRY-1-Q", "MHR-ENTRY-1-D"];
const modes = ["single", "sequential", "simultaneous"] as const;

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

export class MultiplayerEntry {
  private installer: QuestInstaller | null = null;
  private transport: QuestTransport | null = null;
  private code: string | null = null;
  private owner: number | null = null;
  private message = "创建或加入同一个在线大厅后，由大厅房主选波。";
  constructor(private readonly config: RogueConfig, private readonly catalog: MonsterCatalog,
    private readonly canPrepare: () => boolean) {}

  private requireIdle(): void {
    if (!this.canPrepare()) throw new Error("请先结束单人局并等待装备、背包恢复。");
    if (questManager()?.call("isActiveQuest") !== false) throw new Error("请先取消或完成当前已承接任务，再准备联机任务。");
    if (this.transport?.isActive()) throw new Error("正在承接任务，请等待原生柜台关闭。");
  }

  private prepare(index: number): void {
    if (this.config.quest.baseId !== 603 || this.config.quest.mapNo !== 10)
      throw new Error("联机入场实验仅支持模板 603 / 斗技场 10。");
    const mode = modes[index];
    if (!mode) throw new Error("无效的联机选项。");
    const cfg = { ...this.config, quest: { ...this.config.quest, id: ENTRY_QUEST_ID } };
    const wave: WaveOption = { index, mode, typeTag: "MP-ENTRY", label: `联机入场 / ${mode}`,
      monsters: mode === "single" ? ["Great Izuchi"] : ["Great Izuchi", "Great Baggi"],
      tier: "weak", hpMul: 1, dmgMul: 1, rewardMul: 0, rewardPt: 0 };
    const plan = makeQuestPlan(cfg, this.catalog, wave, 1, 1, mode === "sequential");
    // Reuse the installer so already installed hook closures keep the current quest pointer.
    if (!this.installer) this.installer = new QuestInstaller(cfg, plan, true);
    this.installer.publish(plan, false);
    this.code = ENTRY_CODES[index]!;
    this.owner = readLobbyIdentity().host;
    this.message = "任务表已准备。所有人确认任务码一致后，房主承接；队友在游戏任务板加入，房主手动出发。";
  }

  choose(index: number): void {
    this.requireIdle();
    if (readLobbyIdentity().role !== "host") throw new Error("仅原生在线大厅房主可以选择怪物。");
    if (!Number.isInteger(index)) throw new Error("请选择有效选项。");
    this.prepare(index);
  }

  importCode(code: string): void {
    this.requireIdle();
    if (readLobbyIdentity().role !== "guest") throw new Error("仅在线大厅队友可以导入房主任务码。");
    const index = ENTRY_CODES.indexOf(code);
    if (index < 0) throw new Error("任务码不受此版本支持，请与房主安装相同版本。");
    this.prepare(index);
  }

  post(): void {
    const identity = readLobbyIdentity();
    if (!this.canPrepare() || identity.role !== "host" || identity.host !== this.owner || !this.code || !this.installer)
      throw new Error("请由当前大厅房主先选择联机波次。");
    if (!this.transport) this.transport = new QuestTransport(() => this.installer?.getQuest() ?? null, 60);
    this.transport.request(ENTRY_QUEST_ID, true);
    this.message = "正在通过集会所柜台承接。不会自动出发：等队友从任务板加入并准备后，在游戏内手动出发。";
  }

  tick(): void {
    if (this.transport?.isActive()) {
      const identity = readLobbyIdentity();
      if (identity.role !== "host" || identity.host !== this.owner) {
        this.transport.cancel(); this.message = "大厅房主已变化，停止自动承接。"; return;
      }
      this.transport.tick();
      const error = this.transport.getError();
      if (error) this.message = error;
    }
  }

  shutdown(): void { this.transport?.cancel(false); }

  snapshot(): Record<string, unknown> {
    const identity = readLobbyIdentity(), qm = questManager();
    return { ...identity, questId: ENTRY_QUEST_ID, code: this.code,
      planMatchesLobby: this.owner !== null && identity.host === this.owner,
      transport: this.transport?.getStatus() ?? "Idle", message: this.message,
      activeQuest: qm?.call("get_ActiveQuestNo") ?? null,
      playing: qm?.call("isPlayQuest") ?? false,
      nativeQuestPlayerCount: getSingleton("snow.LobbyManager")?.get_field("currentQuestPlayerCount") ?? null,
      canPrepare: this.canPrepare(),
      options: modes.map((mode, index) => ({ index, mode, code: ENTRY_CODES[index],
        label: mode === "single" ? "单怪：镰鼬龙王" : mode === "sequential" ? "顺序：镰鼬龙王 → 眠狗龙王" : "同时：镰鼬龙王 + 眠狗龙王" })),
      scope: "native-entry-experiment", verifiedTwoClients: false };
  }
}
