import { RunCore, fail, ok, type Result } from "./run_core";
import { DEFAULT_RUNTIME, makeQuestPlan, type MonsterCatalog, type QuestPlan, type RuntimeSettings } from "./quest_plan";
import type { WaveOption } from "./run_state";
import type { RogueConfig } from "./config";

export interface Position { x: number; y: number; z: number }
export interface PlayerReading { id: number; position: Position }
export interface EnemyReading {
  uid: number; typeId: number; dead: boolean; captured: boolean;
  position?: { x: number; y: number; z: number };
}
export interface QuestReading { id: number; unique: number; playing: boolean; status: "ready" | "play" | "success" | "failed" | "return" }
export interface RuntimeReading {
  time: number;
  quest: QuestReading | null;
  players: PlayerReading[];
  enemies: EnemyReading[];
  deaths: number;
  online: boolean;
  canPost: boolean;
}
export interface DeathReading { uid: number; typeId: number; kind: "kill" | "capture" }

/** The session knows no REFramework globals. Tests drive the same event loop as the game. */
export interface SessionPort {
  now?(): number;
  ready(): boolean;
  read(): RuntimeReading;
  publish(plan: QuestPlan, inPlace: boolean): void;
  policy(plan: QuestPlan | null, holdClear: boolean): void;
  post(questId: number): void;
  cancelPost(): void;
  postingError(): string | null;
  finish(failed: boolean): void;
  takeDeaths(): DeathReading[];
  report(event: string, detail: unknown): void;
}

export type SessionStage = "Idle" | "Selecting" | "AwaitQuest" | "Combat" | "Carve" | "Returning" | "Finished" | "Fault";

export class RunSession {
  /** The same sampled reading drives both progression and the web console. */
  readingSnapshot: RuntimeReading | null = null;
  stage: SessionStage = "Idle";
  message = "在村庄开始。M2 使用你当前的装备。";
  route: RuntimeSettings["route"];
  readonly settings: RuntimeSettings;
  plan: QuestPlan | null = null;
  private token = 0;
  private lastPoll = -1;
  private nextRunConfig: RogueConfig | null = null;

  configForEditing(): RogueConfig { return this.nextRunConfig ?? this.core.config; }

  validateConfigForSession(config: RogueConfig): void {
    const old = this.core.config;
    if (config.quest.id !== old.quest.id || config.quest.baseId !== old.quest.baseId || config.quest.mapNo !== old.quest.mapNo)
      throw new Error("任务模板和地图需要重启脚本；控制台禁止热替换任务身份");
    const names = Object.keys(this.catalog);
    const known = names.concat(names.map((name) => this.catalog[name]!.cn ?? name));
    for (const pool of config.pools) for (const name of pool.weak.concat(pool.strong ?? [], pool.ultimate ?? [])) {
      if (!known.includes(name)) throw new Error(`怪物不在当前 Rise 目录中：${name}`);
    }
    for (const rule of config.unlockChain) {
      if (!known.includes(rule.monster) || !known.includes(rule.requiresKilling)) throw new Error("解锁链包含未知怪物");
    }
  }

  applyConfig(config: RogueConfig): void {
    const old = this.core.config;
    this.validateConfigForSession(config);
    this.nextRunConfig = config;
    const active = !["Idle", "Finished", "Fault"].includes(this.stage);
    this.core.replaceConfig(active ? { ...config, maxCarts: old.maxCarts,
      startPt: old.startPt, armorOptions: old.armorOptions, runtime: old.runtime,
      cartRestorePrice: old.cartRestorePrice, cartRestoreLimit: old.cartRestoreLimit } : config);
  }
  private requestedAt = 0;
  private progressAt = 0;
  private clearAt = 0;
  private campSince: number | null = null;
  private camp: Position | null = null;
  private roster: number[] = [];
  private questUnique: number | null = null;

  /** 当前任务实例号快照（状态发布用；null=未在任务中）。 */
  get questUniqueSnapshot(): number | null { return this.questUnique; }

  /** 入场时记录的起始点位置（tp-to-camp 用；null=本局尚无记录）。 */
  get campSnapshot(): { x: number; y: number; z: number } | null { return this.camp; }

  preparation() {
    const reading = this.readingSnapshot;
    const players = (reading?.players ?? []).map((player) => ({ ...player,
      campDistance: this.camp ? Math.sqrt((player.position.x - this.camp.x) ** 2 +
        (player.position.y - this.camp.y) ** 2 + (player.position.z - this.camp.z) ** 2) : null }));
    const gathered = this.roster.length > 0 && this.roster.every((id) =>
      players.some((p) => p.id === id && p.campDistance !== null && p.campDistance <= this.settings.campRadius));
    const remaining = this.stage === "Carve" ? Math.max(0, this.settings.carveSeconds - ((reading?.time ?? 0) - this.clearAt)) : 0;
    return { camp: this.camp, radius: this.settings.campRadius, players, gathered,
      carveRemaining: remaining,
      dwellRemaining: this.campSince === null ? this.settings.campDwellSeconds :
        Math.max(0, this.settings.campDwellSeconds - ((reading?.time ?? 0) - this.campSince)),
      seen: this.seen.length, resolved: this.resolved.length,
      expected: this.plan?.monsterIds.length ?? 0, waveToken: this.plan?.token ?? null };
  }

  canShop(): boolean {
    if (this.stage !== "Selecting") return false;
    const r = this.readingSnapshot;
    if (!r || r.online) return false;
    if (!r.quest) return r.canPost;
    return r.quest.playing && r.quest.unique === this.questUnique &&
      r.quest.id === this.plan?.questId && this.preparation().gathered;
  }

  private lastDeaths = 0;
  private seen: EnemyReading[] = [];
  private resolved: EnemyReading[] = [];
  private excludedUids: number[] = [];
  private retryWave = false;
  private testOnly = false;
  private chainKillAt: number | null = null;
  private nextSpawnReported = false;
  private seenSpawnReported = false;

  constructor(readonly core: RunCore, private readonly catalog: MonsterCatalog, private readonly port: SessionPort) {
    this.settings = { ...(core.config.runtime ?? DEFAULT_RUNTIME) };
    this.route = this.settings.route;
  }

  shopQuest(): { questId: number; questUnique: number } | undefined {
    if (this.stage === "Selecting" && this.route === "inPlace" && this.plan && this.questUnique !== null) {
      return { questId: this.plan.questId, questUnique: this.questUnique };
    }
    return undefined;
  }

  private announce(event: string, detail: unknown): void { this.port.report(event, detail); }

  start(armor: string, spike = false): Result {
    try {
      const reading = this.port.read();
      if (!this.port.ready()) return fail("任务安装器尚未就绪");
      if (reading.online) return fail("M2 is solo-only; online quest data/state synchronization is not implemented");
      if (reading.quest !== null || !reading.canPost) return fail("请在村庄且未接任务的状态开始");
      if (!["Idle", "Finished", "Fault"].includes(this.stage)) return fail("会话已在进行中");
      if (this.core.state.phase !== "Idle" && this.core.state.phase !== "GameOver") this.core.abortRun("Starting a new session");
      if (this.nextRunConfig) {
        this.core.replaceConfig(this.nextRunConfig);
        Object.assign(this.settings, this.core.config.runtime ?? DEFAULT_RUNTIME);
        this.nextRunConfig = null;
      }
      const result = this.core.startRun(armor);
      if (!result.ok) return result;
      this.testOnly = spike;
      this.route = this.settings.route;
      this.port.cancelPost();
      this.port.policy(null, false);
      this.plan = null;
      this.retryWave = false;
      this.generate(reading.players.length || 1);
      if (spike) {
        const wave: WaveOption = { index: 0, typeTag: "M2a sequential spike",
          label: "M2a: Great Izuchi -> Great Baggi", monsters: ["Great Izuchi", "Great Baggi"],
          tier: "weak", hpMul: 1, dmgMul: 1, rewardMul: 0, rewardPt: 0 };
        this.core.state.currentChoices = [wave];
        return this.choose(0);
      }
      return ok();
    } catch (error) { return this.fault(error); }
  }

  private generate(players: number): void {
    const lastLayer = Math.max(...this.core.config.pools.map((pool) => pool.to));
    if (this.core.state.layer > lastLayer) {
      this.stage = "Finished";
      this.message = "已完成全部配置层数";
      this.port.policy(null, false);
      return;
    }
    this.core.generateChoices(players);
    this.stage = "Selecting";
    this.message = "选择本层波次；怪物始终由引擎自行刷出。";
  }

  choose(index: number): Result {
    try {
      if (this.stage !== "Selecting") return fail("当前不在选波次阶段");
      const reading = this.port.read();
      if (reading.online) return fail("M2 不支持联机");
      const inPlace = !!reading.quest?.playing;
      if (inPlace && (!this.plan || reading.quest!.id !== this.plan.questId || this.route !== "inPlace")) {
        return fail("发布本波前请先回村");
      }
      const wave = this.core.state.currentChoices.find((choice) => choice.index === index);
      if (!wave) return fail("无效选项");
      // Resolve IDs before changing the core phase; unknown names leave choices retryable.
      const plan = makeQuestPlan(this.core.config, this.catalog, wave, this.core.state.layer,
        ++this.token, this.testOnly || this.settings.spawnMode === "sequential");
      this.port.publish(plan, inPlace);
      const result = this.core.pickChoice(index);
      if (!result.ok) return result;
      this.plan = plan;
      this.port.policy(plan, true);
      this.resetTracking(reading, inPlace);
      if (inPlace) this.stage = "Combat";
      else this.requestPost(reading);
      this.announce("wave-published", { plan, route: this.route, experimentalInPlace: inPlace });
      return ok();
    } catch (error) { return this.fault(error); }
  }

  private resetTracking(reading: RuntimeReading, inPlace: boolean): void {
    this.seen = [];
    this.resolved = [];
    this.excludedUids = inPlace ? reading.enemies.map((enemy) => enemy.uid) : [];
    this.port.takeDeaths();
    this.lastDeaths = inPlace ? reading.deaths : 0;
    this.questUnique = inPlace ? reading.quest!.unique : null;
    if (!inPlace) { this.camp = null; this.roster = []; }
    this.campSince = null;
    this.chainKillAt = null;
    this.nextSpawnReported = false;
    this.seenSpawnReported = false;
    this.progressAt = reading.time;
    this.requestedAt = reading.time;
  }

  private requestPost(reading: RuntimeReading): void {
    this.stage = "AwaitQuest";
    this.requestedAt = reading.time;
    this.message = this.settings.autoPost ? "正在自动接取已准备的任务" : "请手动接取 900102（村庄 > 探索任务）";
    if (this.settings.autoPost && reading.canPost) this.port.post(this.plan!.questId);
  }

  retryPost(): Result {
    try {
      const reading = this.port.read();
      if (!this.plan || reading.quest !== null || !reading.canPost) return fail("请回村且未接任务后重试");
      if (reading.online) return fail("M2 不支持联机");
      if (this.core.state.phase !== "Combat") return fail("没有可重试的已准备波次");
      this.port.cancelPost();
      this.port.publish(this.plan, false);
      this.port.policy(this.plan, true);
      this.resetTracking(reading, false);
      this.requestPost(reading);
      return ok();
    } catch (error) { return this.fault(error); }
  }

  stop(): void {
    const reading = this.port.read();
    this.port.cancelPost();
    this.port.policy(null, false);
    this.core.abortRun("Run stopped");
    if (this.plan && reading.quest?.id === this.plan.questId && reading.quest.playing) this.port.finish(true);
    this.stage = "Finished";
    this.message = "已终止；原生返回流程已恢复";
  }

  tick(): void {
    try {
      const now = this.port.now?.();
      if (now !== undefined && now - this.lastPoll < this.settings.pollSeconds) return;
      const reading = this.port.read();
      if (reading.time - this.lastPoll < this.settings.pollSeconds) return;
      this.lastPoll = reading.time;
      this.readingSnapshot = reading;
      if (["Idle", "Finished", "Fault"].includes(this.stage)) return;
      if (reading.online) { this.fault("Online session detected; native hooks released"); return; }
      const postError = this.port.postingError();
      if (postError) { this.fault(postError); return; }
      if (reading.quest && this.plan && reading.quest.id !== this.plan.questId) {
        this.fault("A different quest is active; refusing to track or modify it"); return;
      }

      if (this.stage === "Returning") {
        if (reading.quest === null && reading.canPost) {
          if (this.testOnly && !this.retryWave) {
            this.stage = "Finished"; this.message = "M2a finished; inspect the spike report";
            this.port.policy(null, false);
          } else if (this.retryWave) {
            this.retryWave = false;
            this.port.publish(this.plan!, false);
            this.port.policy(this.plan, true);
            this.resetTracking(reading, false);
            this.requestPost(reading);
          } else this.generate(reading.players.length || 1);
        }
        return;
      }
      if (this.stage === "Selecting") return;
      if (this.stage === "AwaitQuest") {
        if (reading.quest && this.plan && reading.quest.id === this.plan.questId && reading.quest.playing) {
          // During entry the engine can expose an uninitialised origin for one sample.
          if (reading.players.length === 0 || reading.players.some((p) =>
            p.position.x === 0 && p.position.y === 0 && p.position.z === 0)) {
            if (reading.time - this.requestedAt > this.settings.postTimeoutSeconds)
              this.fault("玩家位置尚未初始化，无法记录集结点；请检查玩家采样接口");
            return;
          }
          this.questUnique = reading.quest.unique;
          this.camp = { ...reading.players[0]!.position };
          this.roster = reading.players.map((player) => player.id);
          this.progressAt = reading.time;
          this.stage = "Combat";
          this.message = "Native quest entered; observing expected monsters";
          this.announce("quest-entered", { unique: this.questUnique, camp: this.camp, roster: this.roster });
        } else {
          if (reading.time - this.requestedAt > this.settings.postTimeoutSeconds) this.fault("Quest entry timed out; retry post or accept the prepared quest manually");
          return;
        }
      }

      if (!reading.quest || reading.quest.unique !== this.questUnique) {
        this.fault("Quest left/restarted before the wave completed; no PT awarded"); return;
      }
      const cartDelta = Math.max(0, reading.deaths - this.lastDeaths);
      this.lastDeaths = reading.deaths;
      for (let i = 0; i < cartDelta && this.core.state.phase !== "GameOver"; i++) this.core.cart();
      if (this.core.state.phase === "GameOver" || reading.quest.status === "failed") {
        this.core.abortRun("Quest failed");
        this.port.policy(null, false);
        if (reading.quest.playing) this.port.finish(true);
        this.stage = "Finished"; this.message = "Run over; native return flow is enabled";
        return;
      }
      // A quiet engine after an experimental table replacement is not evidence of settlement.
      // Let the bounded no-spawn fallback run; explicit success/return still releases ownership.
      const waitingInPlace = this.route === "inPlace" && this.stage === "Combat" &&
        this.seen.length === 0 && reading.quest.status === "ready";
      if (!reading.quest.playing && !waitingInPlace) {
        this.fault("Native quest is no longer playing; inspect its status before retrying"); return;
      }

      if (this.stage === "Combat") {
        const unexpected = reading.enemies.find((enemy) => !enemy.dead && !enemy.captured &&
          !this.excludedUids.includes(enemy.uid) && !this.plan!.monsterIds.includes(enemy.typeId));
        if (unexpected) {
          this.announce("unexpected-monster", unexpected);
          this.fault(`Unexpected native monster ${unexpected.typeId}; no PT awarded`);
          return;
        }
        this.observe(reading);
        if (this.resolved.length === this.plan!.monsterIds.length) {
          this.core.killWave();
          this.stage = "Carve";
          this.clearAt = reading.time;
          this.campSince = null;
          this.message = "Wave cleared. Carve, then return to the captured starting point.";
          this.announce("wave-cleared", { token: this.plan!.token, reward: this.plan!.wave.rewardPt, resolved: this.resolved });
        } else if (reading.time - this.progressAt > this.settings.spawnTimeoutSeconds &&
          !reading.enemies.some((enemy) => !enemy.dead && !enemy.captured && this.plan!.monsterIds.includes(enemy.typeId) && !this.excludedUids.includes(enemy.uid))) {
          if (this.route === "inPlace") {
            this.route = "reentry";
            this.retryWave = true;
            this.port.policy(this.plan, false);
            this.port.finish(false);
            this.stage = "Returning";
            this.message = "No native spawn after table replacement; falling back to quest reentry (no PT awarded)";
            this.announce("in-place-no-go", { token: this.plan!.token });
          } else if (this.plan!.sequential && this.plan!.monsterIds.length > 1 && !this.testOnly) {
            // Reentry alone cannot fix a broken HP-triggered native sequence. Publish the
            // next attempt with every target DEFAULT, so the engine starts them together.
            this.plan = { ...this.plan!, sequential: false, token: ++this.token };
            this.retryWave = true;
            this.port.policy(this.plan, false);
            this.port.finish(false);
            this.stage = "Returning";
            this.message = "Native sequence did not complete; retrying this layer with simultaneous native targets (no PT awarded)";
            this.announce("sequential-no-go", { token: this.plan.token, fallback: "reentry-simultaneous" });
          } else this.fault("Expected monster did not spawn. Inspect slot conditions / arena compatibility; the wave was not cleared.");
        }
      }
      if (this.stage === "Carve") this.checkCamp(reading);
    } catch (error) {
      const now = this.port.now?.();
      if (now !== undefined) this.lastPoll = now;
      this.fault(error);
    }
  }

  private observe(reading: RuntimeReading): void {
    const candidates = reading.enemies.concat(this.port.takeDeaths().map((event) =>
      ({ uid: event.uid, typeId: event.typeId, dead: event.kind === "kill", captured: event.kind === "capture" })));
    for (const enemy of candidates) {
      if (!this.plan!.monsterIds.includes(enemy.typeId) || this.excludedUids.includes(enemy.uid)) continue;
      if (!this.seen.some((seen) => seen.uid === enemy.uid)) {
        const required = this.plan!.monsterIds.filter((type) => type === enemy.typeId).length;
        if (this.seen.filter((seen) => seen.typeId === enemy.typeId).length >= required) continue;
        this.seen.push(enemy);
        this.progressAt = reading.time;
        this.announce("monster-observed", { ...enemy, token: this.plan!.token });
        if (this.chainKillAt !== null && !this.nextSpawnReported) {
          this.nextSpawnReported = true;
          this.announce("sequential-spawn", { seconds: reading.time - this.chainKillAt,
            withinTenSeconds: reading.time - this.chainKillAt <= 10 });
        } else if (this.seen.length > 1 && this.chainKillAt === null && !this.seenSpawnReported) {
          this.seenSpawnReported = true;
          this.announce("overlapping-spawns", { token: this.plan!.token });
        }
      }
      if ((enemy.dead || enemy.captured) && !this.resolved.some((resolved) => resolved.uid === enemy.uid)) {
        this.resolved.push(enemy);
        this.progressAt = reading.time;
        if (this.chainKillAt === null) this.chainKillAt = reading.time;
      }
    }
    this.message = `Native monsters: ${this.seen.length}/${this.plan!.monsterIds.length} seen, ${this.resolved.length} resolved`;
  }

  private checkCamp(reading: RuntimeReading): void {
    if (reading.time - this.clearAt < this.settings.carveSeconds || this.camp === null) return;
    // An absent/disconnected player never counts as gathered. The roster is fixed on entry.
    const gathered = this.roster.length > 0 && this.roster.every((id) => {
      const player = reading.players.find((player) => player.id === id);
      if (!player) return false;
      const p = player.position;
      const c = this.camp!;
      return (p.x - c.x) ** 2 + (p.y - c.y) ** 2 + (p.z - c.z) ** 2 <= this.settings.campRadius ** 2;
    });
    if (!gathered) { this.campSince = null; return; }
    if (this.campSince === null) this.campSince = reading.time;
    if (reading.time - this.campSince < this.settings.campDwellSeconds) return;
    this.core.returnToCamp();
    this.announce("camp-gathered", { token: this.plan!.token });
    if (this.route === "inPlace" && !this.testOnly) this.generate(reading.players.length || 1);
    else {
      this.port.policy(this.plan, false);
      this.port.finish(false);
      this.stage = "Returning";
      this.message = "Returning through the native quest flow; PT and carts remain in this run";
    }
  }

  private fault(error: unknown): Result {
    if (this.stage === "Fault" && this.message === String(error)) return fail(this.message);
    this.stage = "Fault";
    this.message = String(error);
    this.port.policy(null, false);
    this.port.cancelPost();
    this.announce("runtime-error", { error: this.message, plan: this.plan });
    return fail(this.message);
  }
}
