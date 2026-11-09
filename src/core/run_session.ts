import {rollSupplyDrops, type SupplyDrop} from "./supply_drops";
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
export type QuestIdentity = Pick<QuestReading, "id" | "unique">;
export interface RuntimeReading {
  time: number;
  quest: QuestReading | null;
  /** Explicit native activity observation; absent when QuestManager is unavailable. */
  nativeQuestActive?: boolean;
  players: PlayerReading[];
  localPlayerId?: number | null;
  enemies: EnemyReading[];
  deaths: number;
  online: boolean;
  canPost: boolean;
  /** True when the arena quest object of a stopped/failed run is still registered. */
  staleQuest?: boolean;
  /** Native load completion and running quest clock; isPlayQuest alone precedes actor placement. */
  entryReady?: boolean;
}
export interface DeathReading { uid: number; typeId: number; kind: "kill" | "capture" }

/** The session knows no REFramework globals. Tests drive the same event loop as the game. */
export interface SessionPort {
  now?(): number;
  ready(): boolean;
  read(): RuntimeReading;
  /** Freeze services/native preparation to this run's rules before any grant. */
  configureRun?(config: RogueConfig): void;
  publish(plan: QuestPlan, inPlace: boolean): void;
  policy(plan: QuestPlan | null, holdClear: boolean): void;
  post(questId: number): void;
  cancelPost(): void;
  /** Optional: re-point the transport after a stopped run left its quest registered. */
  retarget?(questId: number): void;
  postingError(): string | null;
  waitingForSpawnCapacity?(): boolean;
  finish(failed: boolean, expected: QuestIdentity): void;
  /** Pin the owned native instance against success while the host queues failure. No native finish call. */
  guardFailure?(expected: QuestIdentity): void;
  takeDeaths(): DeathReading[];
  report(event: string, detail: unknown): void;
  /** M3.5 开局准备（穿装+袋隔离）；实现方保证不抛异常。缺省=测试假 port。notice=非阻断警告。 */
  startupPrepare?(armor: string): { ok: boolean; reason?: string; notice?: string };
  /** 回村恢复原装（幂等）；失败返回 ok=false，会话稍后重试。 */
  startupRestore?(): { ok: boolean; reason?: string };
  /** V1.3 §2.3 极强击杀掉落：ultimate 波清波后触发一次顶级抽取（免费、发件入局末清理）。 */
  supplyDrop?(itemId: string, count: number): { granted: boolean; actual?: number; deferred?: boolean; reason?: string };
  ultimateDrop?(): { ok: boolean; name?: string; reused?: boolean; reason?: string };
  /** 离线队友调研 §6C：权威参战人数（混合实机 mock 名单）。null=沿用原生人数。 */
  partySize?(): number | null;
  allowEntryHostTest?(reading: RuntimeReading): boolean;
  multiplayerRole?(): "host" | "guest" | null;
  multiplayerValid?(): boolean;
  multiplayerCanChoose?(): boolean;
  multiplayerConfigBusy?(): boolean;
  canFinishLocal?(): boolean;
}

export type SessionStage = "Idle" | "Preparing" | "Selecting" | "AwaitQuest" | "Combat" | "Carve" | "Returning" | "Finished" | "Fault";
export const RUN_END_INTENTS=["cleared-all","carts-exhausted","stopped","fault","native-ended","quest-left","entry-cancelled"] as const;
export type RunEndIntent=typeof RUN_END_INTENTS[number];
export interface NativeEndObservation {
  questId:number;unique:number;status:"success"|"failed"|"return";deaths:number|null;observedAt:number;
  conflictingStatus?:"success"|"failed";
}

export class RunSession {
  /** The same sampled reading drives both progression and the web console. */
  readingSnapshot: RuntimeReading | null = null;
  externalConfigRevision=0;
  configurationRecovered():void{this.externalConfigRevision++;}
  stage: SessionStage = "Idle";
  message = "在村庄开始。M2 使用你当前的装备。";
  route: RuntimeSettings["route"];
  readonly settings: RuntimeSettings;
  plan: QuestPlan | null = null;
  private token = 0;
  private lastPoll = -1;
  private nextRunConfig: RogueConfig | null = null;
  /** 开局准备已成功、原装尚未恢复（回村后由 tick 执行恢复）。 */
  private startupRestorePending = false;
  /** 本会话成功执行过开局准备（fault/stop 时据此决定是否需要恢复）。 */
  private startupPrepared = false;
  private preparationQuest: number | null = null;
  private abortQuest: { id: number; unique: number; kind: "stop" | "fault" } | null = null;
  private startupNotice: string | null = null;

  /** 脚本重载后恢复"上局未恢复"状态（main.ts 读持久化文件后调用）。 */
  armStartupRestore(): void {
    if (this.port.startupRestore) this.startupRestorePending = true;
  }

  get startupMessage(): string | null { return this.startupNotice; }
  get startupStatus() { return { prepared: this.startupPrepared, restorePending: this.startupRestorePending, message: this.startupNotice }; }
  /** Called immediately BEFORE the engine serializes this character. Restore only
   * an ended owned run or an already loaded village recovery, never Preparing/Combat. */
  prepareForNativeSave():void {
    if (!this.startupRestorePending || !this.port.startupRestore) return;
    const r=this.port.read(),q=r.quest;
    const village=r.canPost && r.players.length>0 && (!q || r.staleQuest===true);
    const terminal=["Finished","Fault"].includes(this.stage);
    const ended=terminal && !!q && !q.playing && q.id===this.plan?.questId &&
      (this.questUnique===null || q.unique===this.questUnique) && ["failed","return","success"].includes(q.status);
    // Result saving can happen after QuestManager cleared the quest, while the
    // player list and village UI are still loading. The ended session remains pinned.
    const clearedEnding=!q && r.nativeQuestActive===false && this.plan!==null && terminal;
    if (village && ["Idle","Finished","Fault"].includes(this.stage) || ended || clearedEnding) {
      const result=this.port.startupRestore();
      if (!result.ok) {
        this.startupNotice=result.reason ?? "等待原生保存";
        this.message=`原装恢复待办：${this.startupNotice}`;
      }
    }
  }
  get nextRoute(): RuntimeSettings["route"] { return this.nextRunConfig?.runtime?.route ?? this.settings.route; }
  setRunRoute(route: RuntimeSettings["route"]): void {
    if (!["Idle", "Finished", "Fault"].includes(this.stage)) throw new Error("路线只能在开局前切换");
    this.settings.route = route; this.route = route;
    const next = this.configForEditing();
    this.nextRunConfig = { ...next, runtime: { ...(next.runtime ?? DEFAULT_RUNTIME), route } };
    this.configSubmitted?.(this.nextRunConfig);
  }


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

  previewConfig(config: RogueConfig): RogueConfig {
    const old = this.core.config;
    this.validateConfigForSession(config);
    const active = !["Idle", "Finished", "Fault"].includes(this.stage);
    return active ? { ...config, maxCarts: old.maxCarts,
      startPt: old.startPt, armorOptions: old.armorOptions, runtime: old.runtime,
      armorSets:old.armorSets, startupRules:old.startupRules, gachaPools:old.gachaPools, buffAmounts:old.buffAmounts,
      cartRestorePrice: old.cartRestorePrice, cartRestoreLimit: old.cartRestoreLimit } : config;
  }
  configurationSnapshot(): { active:RogueConfig; next:RogueConfig|null } {
    return {active:this.core.config,next:this.nextRunConfig??null};
  }
  restoreConfiguration(snapshot:{active:RogueConfig;next:RogueConfig|null}):void {
    this.core.replaceConfig(snapshot.active);this.nextRunConfig=snapshot.next;
    this.configSubmitted?.(snapshot.next??snapshot.active);
  }
  applyConfig(config: RogueConfig): void {
    const effective=this.previewConfig(config);
    this.nextRunConfig=config;this.core.replaceConfig(effective);
    this.configSubmitted?.(config);
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

  get multiplayerAbortPending(): boolean {
    const q = this.readingSnapshot?.quest, abort = this.abortQuest;
    return !!abort && !!q?.playing && q.id === abort.id && q.unique === abort.unique;
  }

  get multiplayerAbortKind(): "stop" | "fault" | null { return this.abortQuest?.kind ?? null; }

  private requestMultiplayerAbort(reading: RuntimeReading, kind: "stop" | "fault"): void {
    const q = reading.quest;
    if (!this.multiplayerRole || !q?.playing || q.id !== this.plan?.questId ||
        (this.questUnique !== null && q.unique !== this.questUnique)) return;
    this.port.guardFailure?.({ id:q.id, unique:q.unique });
    this.abortQuest = { id: q.id, unique: q.unique, kind };
  }

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
    return { camp: this.camp, radius: this.settings.campRadius, players, gathered, localPlayerId: reading?.localPlayerId ?? null,
      carveRemaining: remaining,
      dwellRemaining: this.campSince === null ? this.settings.campDwellSeconds :
        Math.max(0, this.settings.campDwellSeconds - ((reading?.time ?? 0) - this.campSince)),
      seen: this.seen.length, resolved: this.resolved.length,
      expected: this.plan?.monsterIds.length ?? 0, waveToken: this.plan?.token ?? null };
  }

  canShop(): boolean {
    if(this.multiplayerRole&&this.port.multiplayerConfigBusy?.())return false;
    if (this.stage === "Preparing") {
      const r = this.readingSnapshot;
      return this.startupPrepared && !!r && (r.quest
        ? r.quest.id === this.plan?.questId && !r.quest.playing && r.quest.status === "ready"
        : r.canPost);
    }
    if (this.stage !== "Selecting") return false;
    const r = this.readingSnapshot;
    if (!r || (r.online && !this.onlineAllowed(r))) return false;
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
  private entryHostRun = false;
  earnedPt = 0;
  private startedAt = 0;
  private clearedWaves = 0;
  private endIntent:RunEndIntent|null=null;
  private nativeEnd:NativeEndObservation|null=null;
  get endingIntent():RunEndIntent|null{return this.endIntent;}
  /** Native failure can arrive before the host's terminal frame. Reconcile only
   * the explanation of that pinned run; never replay accounting or native work. */
  reconcileMultiplayerEnd(plan:QuestPlan,intent:RunEndIntent|null|undefined):void {
    const q=this.readingSnapshot?.quest;
    if(this.multiplayerRole!=="guest"||this.stage!=="Finished"||this.endIntent!=="native-ended"||
      !intent||!["cleared-all","carts-exhausted","stopped","fault"].includes(intent)||
      !this.plan||plan.token!==this.plan.token||plan.layer!==this.plan.layer||plan.questId!==this.plan.questId||
      this.questUnique===null||!q||q.playing||q.id!==plan.questId||q.unique!==this.questUnique||
      this.nativeEnd?.unique!==q.unique||this.nativeEnd.questId!==q.id)return;
    this.endIntent=intent;
    this.announce("multiplayer-ending-reconciled",{intent,questId:q.id,unique:q.unique,token:plan.token});
  }
  private resetRunEnd():void{this.endIntent=null;this.nativeEnd=null;}
  private markRunEnd(intent:RunEndIntent):void{if(this.endIntent===null)this.endIntent=intent;}
  /** A host Finished frame expresses intent, never this engine's result.
   * Continue observing the pinned local quest after business progression ends. */
  private observeNativeEnd(reading:RuntimeReading):void {
    const q=reading.quest,owned=this.questUnique??this.preparationQuest;
    if(!q||!this.plan||owned===null||q.id!==this.plan.questId||q.unique!==owned||
      !["success","failed","return"].includes(q.status))return;
    const status=q.status as NativeEndObservation["status"];
    if(this.nativeEnd&&this.nativeEnd.status!=="return"){
      if(status!=="return"&&status!==this.nativeEnd.status&&this.nativeEnd.conflictingStatus!==status){
        this.nativeEnd={...this.nativeEnd,conflictingStatus:status};
        this.announce("native-end-conflict",{...this.nativeEnd});
      }
      return;
    }
    if(this.nativeEnd?.status===status)return;
    this.nativeEnd={questId:q.id,unique:q.unique,status,
      deaths:Number.isInteger(reading.deaths)&&reading.deaths>=0?reading.deaths:null,observedAt:reading.time};
    this.announce("native-end-observed",{...this.nativeEnd});
  }
  private pendingSupplies: SupplyDrop[] = [];
  supplyLoot: {itemId:string;count:number;actual:number;granted:boolean;reason?:string}[] = [];
  runSummary() { return { layer:this.core.state.layer, clearedWaves:this.clearedWaves,
    earnedPt:this.earnedPt, spentPt:this.core.config.startPt+this.earnedPt-this.core.state.wallet.pt,
    balance:this.core.state.wallet.pt, remainingCarts:this.core.state.cartsLeft,
    cartRestored:this.core.state.cartRestoreUsed, armor:this.core.state.armor,
    purchases:this.core.state.wallet.purchaseLog.slice(), reason:this.message,
    durationSeconds:Math.max(0,(this.readingSnapshot?.time ?? this.startedAt)-this.startedAt),
    restored:!this.startupRestorePending, role:this.multiplayerRole,maxCarts:this.core.config.maxCarts,
    ending:{intent:this.endIntent,native:this.nativeEnd?{...this.nativeEnd}:null} }; }
  private queueSupplies(plan: QuestPlan): void {
    this.clearedWaves++;
    this.pendingSupplies.push(...rollSupplyDrops(this.core.config.supplyDrops, plan.monsterIds.length, w=>this.core.rollWeighted(w)));
  }
  private deliverSupplies(): void {
    if (!this.port.supplyDrop || !["Carve","Selecting"].includes(this.stage)) return;
    while(this.pendingSupplies.length > 0) {
      const item=this.pendingSupplies[0]!; const report=this.port.supplyDrop(item.itemId,item.count);
      if (report.deferred) return; // Host clear may arrive before the guest's native death.
      this.pendingSupplies.shift();
      this.supplyLoot.push({...item,actual:report.actual??0,granted:report.granted,reason:report.reason});
      if(this.supplyLoot.length>10)this.supplyLoot.shift();
      this.announce("supply-drop",this.supplyLoot[this.supplyLoot.length-1]);
    }
  }
  private mirroredReward = 0;
  private mirroredClears: number[] = [];
  get multiplayerRole(): "host" | "guest" | null { return this.port.multiplayerRole?.() ?? null; }
  canChoose(): boolean { return this.multiplayerRole !== "guest" && this.canShop() && (!this.multiplayerRole || this.port.multiplayerCanChoose?.() === true); }
  failMultiplayer(reason: string): void { this.fault(reason); }
  adoptMultiplayerEntry(plan: QuestPlan): Result {
    if (!this.multiplayerRole || !this.port.multiplayerValid?.()) return fail("Multiplayer identity unavailable");
    return this.adoptPostedEntry(plan);
  }
  /** Called only after MultiplayerEntry has pinned a native lobby and validated its plan. */
  prepareMultiplayer(plan: QuestPlan, armor: string): Result {
    const r = this.port.read();
    if (r.quest || !r.canPost || plan.questId !== 900103 || this.core.config.quest.id !== 900103)
      return fail("请在联机大厅村庄、未承接任务时准备本局");
    if (this.stage === "Preparing" && this.startupPrepared) { this.plan = plan; return ok(); }
    if (!["Idle", "Finished", "Fault"].includes(this.stage) || this.startupRestorePending)
      return fail("上局恢复尚未完成");
    if (!this.core.config.armorOptions.includes(armor)) return fail("未知初始装备");
    Object.assign(this.settings,this.core.config.runtime ?? DEFAULT_RUNTIME);
    this.nextRunConfig=null;
    this.port.configureRun?.(this.core.config);
    const prepared = this.port.startupPrepare?.(armor);
    if (!prepared?.ok || prepared.notice) {
      this.startupRestorePending = true;
      return this.fault(prepared?.reason ?? prepared?.notice ?? "联机开局准备接口不可用");
    }
    this.startupPrepared = true; this.startupRestorePending = true;
    const started = this.core.startRun(armor);
    if (!started.ok) return this.fault(started.message);
    this.resetRunEnd();
    this.startedAt = r.time;
    this.plan = plan; this.stage = "Preparing"; this.route = "inPlace";
    this.readingSnapshot = r;
    this.message = "本机零物资与初始装备已准备，可用初始 PT 购物；全队准备后承接并出发";
    this.announce("multiplayer-startup-prepared", { armor, pt: this.core.state.wallet.pt });
    return ok();
  }
  /** Guest has its own wallet. Apply cumulative host rewards once, never copy host spending. */
  mirrorMultiplayer(frame: { stage: SessionStage; phase: import("./run_state").RunPhase; layer: number;
    plan: QuestPlan; choices: WaveOption[]; earned: number; carts: number; camp: Position | null;
    cartUsed: boolean; killed: string[];endIntent?:RunEndIntent|null }): void {
    if (this.multiplayerRole !== "guest" || !this.port.multiplayerValid?.()) throw new Error("Guest mirror scope ended");
    const q = this.readingSnapshot?.quest;
    if (!q || q.id !== frame.plan.questId || (this.questUnique !== null && q.unique !== this.questUnique))
      throw new Error("Guest mirror native quest instance changed");
    if (frame.earned < this.mirroredReward) throw new Error("Multiplayer reward total went backwards");
    const terminal = ["Finished", "Fault"].includes(frame.stage);
    const intent = frame.endIntent ?? (frame.stage === "Fault" ? "fault" : "native-ended");
    // Receiving host intent must not release completed native objectives before
    // the engine receives failure. This guard never ends a guest's native quest.
    if (terminal && q.playing && ["stopped", "fault", "carts-exhausted"].includes(intent)) this.port.guardFailure?.({ id:q.id, unique:q.unique });
    const newReward = frame.earned > this.mirroredReward;
    this.core.state.wallet.pt += frame.earned - this.mirroredReward;
    this.mirroredReward = frame.earned; this.earnedPt = frame.earned;
    const cleared = newReward || frame.stage === "Carve" || frame.stage === "Selecting" && frame.layer > 1;
    if (cleared && !this.mirroredClears.includes(frame.plan.token)) {
      this.mirroredClears.push(frame.plan.token);
      if (this.mirroredClears.length > 256) this.mirroredClears.shift();
      if (terminal) this.clearedWaves++;
      else {
        this.queueSupplies(frame.plan);
        if (frame.plan.wave.tier === "ultimate") this.grantUltimateDrop();
      }
    }
    if (terminal) this.markRunEnd(intent);
    this.stage = frame.stage; this.core.state.phase = frame.phase; this.core.state.layer = frame.layer;
    this.core.state.cartsLeft = frame.carts; this.core.state.cartRestoreUsed = frame.cartUsed;
    this.core.state.killedUltimates = [...frame.killed];
    this.core.state.currentChoices = frame.choices; this.core.state.activeWave = frame.phase === "Combat" || frame.phase === "Carve" ? frame.plan.wave : null;
    this.plan = frame.plan; this.token = frame.plan.token; this.camp = frame.camp;
    this.roster = this.readingSnapshot?.players.map(p => p.id) ?? [];
    if (q?.playing) this.questUnique = q.unique;
    this.message = frame.stage==="Fault"?"房主因错误停止本局，等待本机原生结算与个人恢复":
      frame.stage==="Finished"?"房主已结束本局，等待本机原生结果与个人恢复":"联机同步：由房主选波，个人 PT 和购物独立结算";
    this.port.policy(frame.plan, !terminal);
  }

  constructor(readonly core: RunCore, private readonly catalog: MonsterCatalog, private readonly port: SessionPort,
    private readonly configSubmitted?: (config: RogueConfig) => void) {
    this.settings = { ...(core.config.runtime ?? DEFAULT_RUNTIME) };
    this.route = this.settings.route;
  }

  private onlineAllowed(reading: RuntimeReading): boolean {
    return this.port.allowEntryHostTest?.(reading) === true || (!!this.multiplayerRole && this.port.multiplayerValid?.() === true);
  }
  shopQuest(): { questId: number; questUnique: number; entryHostTest?: boolean; multiplayer?: boolean; preparing?: boolean } | undefined {
    if (this.stage === "Preparing" && this.plan) return { questId: this.plan.questId,
      questUnique: this.readingSnapshot?.quest?.unique ?? -1, multiplayer: true, preparing: true };
    if (this.stage === "Selecting" && this.route === "inPlace" && this.plan && this.questUnique !== null) {
      return { questId: this.plan.questId, questUnique: this.questUnique,
        ...(this.readingSnapshot && this.port.allowEntryHostTest?.(this.readingSnapshot) ? { entryHostTest: true } : {}),
        ...(this.multiplayerRole && this.port.multiplayerValid?.() ? { multiplayer: true } : {}) };
    }
    return undefined;
  }

  private announce(event: string, detail: unknown): void { this.port.report(event, detail); }

  adoptPostedEntry(plan: QuestPlan): Result {
    const reading = this.port.read();
    if (!["Idle", "Preparing"].includes(this.stage) || plan.questId !== 900103 || this.core.config.quest.id !== 900103 ||
        reading.quest?.id !== plan.questId || !this.onlineAllowed(reading)) return fail("Entry host test scope unavailable");
    const started = this.stage === "Preparing" && this.startupPrepared ? ok() : this.core.startRun(this.core.config.armorOptions[0]!);
    if (!started.ok) return started;
    if(this.stage!=="Preparing")this.resetRunEnd();
    this.core.generateChoices(1);
    this.core.state.currentChoices = [plan.wave];
    const picked = this.core.pickChoice(plan.wave.index);
    if (!picked.ok) return picked;
    this.plan = plan; this.token = plan.token; this.route = "inPlace";
    this.entryHostRun = !this.multiplayerRole;
    this.testOnly = false; this.resetTracking(reading, false);
    if (this.multiplayerRole === "guest" && reading.quest?.playing) this.questUnique = reading.quest.unique;
    this.port.policy(plan, true);
    this.stage = "AwaitQuest";
    this.message = this.multiplayerRole ? "联机局已接入：首波正常计分，保留开局购物结果，由房主选波" : "房主本机接线测试";
    this.announce(this.multiplayerRole ? "multiplayer-adopted" : "entry-host-adopted", { plan, scope: this.multiplayerRole ?? "one-native-host-only", startupIsolation: this.startupPrepared });
    return ok();
  }

  start(armor: string, spike = false, testLayer?: number): Result {
    try {
      const reading = this.port.read();
      if (!this.port.ready()) return fail("任务安装器尚未就绪");
      if (reading.online) return fail("M2 is solo-only; online quest data/state synchronization is not implemented");
      // A stopped run leaves its quest object registered until the counter is invoked
      // again; that is not "another quest is running". A live quest or a pending post
      // still blocks, and start() cancels a stale registration through the transport.
      if ((reading.quest !== null && !reading.staleQuest) || !reading.canPost)
        return fail("请在村庄且未接任务的状态开始");
      if (!["Idle", "Finished", "Fault"].includes(this.stage)) return fail("会话已在进行中");
      if (this.core.state.phase !== "Idle" && this.core.state.phase !== "GameOver") this.core.abortRun("Starting a new session");
      if (this.nextRunConfig) {
        this.core.replaceConfig(this.nextRunConfig);
        Object.assign(this.settings, this.core.config.runtime ?? DEFAULT_RUNTIME);
        this.nextRunConfig = null;
      }
      // M3.5 开局准备（穿装+袋隔离）必须在接任务之前：任务装备包在接任务时快照。
      this.port.configureRun?.(this.core.config);
      if (this.port.startupPrepare) {
        const prep = this.port.startupPrepare(armor);
        this.startupNotice = prep.ok ? prep.notice ?? null : null;
        if (!prep.ok) { this.startupRestorePending = true; return fail(prep.reason ?? "开局穿装失败"); }
        this.startupPrepared = true;
      }
      this.startedAt = reading.time;
      const result = this.core.startRun(armor);
      if (!result.ok) {
        // 穿装已完成但 PT 发放失败：仍需回村恢复原装
        if (this.port.startupPrepare) this.startupRestorePending = true;
        return result;
      }
      this.resetRunEnd();
      this.startupRestorePending = this.port.startupPrepare !== undefined;
      // 测试直跳层（仅单人离线；跳过逐层进程直接检验目标层生成与结算）
      if (testLayer !== undefined) {
        if (!Number.isInteger(testLayer) || testLayer < 1) return fail("testLayer 必须是正整数");
        this.core.state.layer = testLayer;
        this.announce("test-layer", { layer: testLayer });
      }
      // startRun resets layer/PT but keeps the combat log; the new session must not
      // inherit the previous run's log lines.
      this.core.state.log = [];
      this.testOnly = spike;
      this.route = this.settings.route;
      this.port.cancelPost();
      // A stopped run can leave its quest registered (status failed/return) until the
      // counter takes another quest. Retarget the transport at ours so the next post
      // is not refused as "another quest was accepted".
      if (reading.staleQuest && this.port.retarget) this.port.retarget(this.core.config.quest.id);
      this.port.policy(null, false);
      this.plan = null;
      this.retryWave = false;
      this.generate(this.partySize(reading));
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

  /** Prefer the runtime's fixed party size; otherwise use the observed native players. */
  private partySize(reading: RuntimeReading): number {
    const fromParty = this.port.partySize?.() ?? null;
    return fromParty ?? (reading.players.length || 1);
  }

  private generate(players: number): void {
    const lastLayer = Math.max(...this.core.config.pools.map((pool) => pool.to));
    if (this.core.state.layer > lastLayer) {
      this.markRunEnd("cleared-all");
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
      if (this.multiplayerRole && !this.canChoose()) return fail("仅房主在全队同步就绪后选择波次");
      if (this.stage !== "Selecting") return fail("当前不在选波次阶段");
      const reading = this.port.read();
      if (reading.online && !this.onlineAllowed(reading)) return fail("M2 不支持联机");
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
    if (!inPlace) { this.nativeEnd = null; this.camp = null; this.roster = []; }
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
    this.observeNativeEnd(reading);this.markRunEnd("stopped");
    this.port.cancelPost();
    this.requestMultiplayerAbort(reading, "stop");
    if ((this.port.canFinishLocal?.() ?? this.multiplayerRole !== "guest") && this.plan && reading.quest?.id === this.plan.questId && reading.quest.playing &&
        (this.questUnique === null || this.questUnique === reading.quest.unique)) this.finishQuest(true, reading);
    this.port.policy(null, false);
    this.core.abortRun("Run stopped");
    if (this.startupPrepared) this.startupRestorePending = true;
    this.stage = "Finished";
    this.message = "已终止；回村后自动恢复原装备";
  }

  tick(): void {
    try {
      const now = this.port.now?.();
      if (now !== undefined && now - this.lastPoll < this.settings.pollSeconds) return;
      const reading = this.port.read();
      if (reading.time - this.lastPoll < this.settings.pollSeconds) return;
      this.lastPoll = reading.time;
      this.readingSnapshot = reading;
      this.observeNativeEnd(reading);
      // M3.5 恢复检查在 stage 早退之前：Finished/Fault 后回到村庄也要恢复原装。
      // 不能在活跃局内触发——inPlace 首波前 Selecting 与 reentry 波间 Selecting 都在村庄。
      if (this.startupRestorePending && this.port.startupRestore &&
        ["Idle", "Finished", "Fault"].includes(this.stage)) {
        const backInVillage = reading.canPost && reading.players.length > 0 && (!reading.quest || reading.staleQuest === true);
        if (backInVillage) {
          const restore = this.port.startupRestore();
          if (restore.ok) {
            this.startupRestorePending = false;
            this.startupPrepared = false;
            this.startupNotice = null;
            this.announce("startup-restored", restore);
          } else {
            this.startupNotice=restore.reason ?? "未知";
            this.message = `原装恢复待办：${this.startupNotice}`;
          }
        }
      }
      if (["Idle", "Finished", "Fault"].includes(this.stage)) return;
      // Native failure/return is authoritative on EVERY peer, including Selecting and guests.
      // It must be observed before the guest/progression and scope early returns below.
      const pinned = this.questUnique !== null && this.plan !== null;
      const same = reading.quest?.id === this.plan?.questId && reading.quest?.unique === this.questUnique;
      if ((this.multiplayerRole || this.stage === "Preparing") && ((this.stage === "Preparing" && reading.quest && reading.quest.id === this.plan?.questId &&
            ["failed", "return", "success"].includes(reading.quest.status)) ||
          (pinned && (!same || !!reading.quest && ["failed", "return", "success"].includes(reading.quest?.status ?? ""))))) {
        this.markRunEnd(same?"native-ended":"quest-left");
        if (same && Number.isInteger(reading.deaths) && reading.deaths >= 0)
          this.core.state.cartsLeft = Math.max(0,this.core.config.maxCarts-reading.deaths);
        this.core.abortRun("原生任务已结束或离开"); this.port.policy(null, false); this.port.cancelPost();
        this.stage = "Finished"; this.message = "本局已结束，等待原生回村并恢复个人装备与背包";
        this.announce("native-run-ended", { quest: reading.quest, deaths: reading.deaths });
        return;
      }
      if (this.stage === "Preparing") {
        if (reading.quest?.id === this.plan?.questId) this.preparationQuest = reading.quest?.unique ?? null;
        else if (this.preparationQuest !== null) {
          this.markRunEnd("entry-cancelled");
          this.core.abortRun("原生入场任务已取消"); this.stage = "Finished";
          this.message = "已取消入场，回村恢复后可重新准备";
        }
        return;
      }
      if (pinned && same && this.multiplayerRole !== "guest") {
        const delta = Math.max(0, reading.deaths - this.lastDeaths); this.lastDeaths = reading.deaths;
        for (let i = 0; i < delta && this.core.state.phase !== "GameOver"; i++) this.core.cart(reading.quest?.playing === true);
        if (this.core.state.phase === "GameOver") {
          this.markRunEnd("carts-exhausted");
          if (reading.quest?.playing) this.finishQuest(true, reading);
          this.port.policy(null, false);
          this.stage = "Finished"; this.message = "全队猫车耗尽，等待原生结算与个人恢复";
          return;
        }
      }
      if (this.entryHostRun && !this.port.allowEntryHostTest?.(reading)) {
        this.fault("Entry host test identity changed or a real teammate joined"); return;
      }
      if (reading.online && !this.onlineAllowed(reading)) { this.fault("Online session detected; native hooks released"); return; }
      if (this.multiplayerRole && !this.port.multiplayerValid?.()) { this.fault("联机房间、房主或固定队伍已改变"); return; }
      this.deliverSupplies();
      // The guest reads native facts but never runs the host progression or awards itself kills.
      if (this.multiplayerRole === "guest") return;
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
          } else this.generate(this.partySize(reading));
        }
        return;
      }
      if (this.stage === "Selecting") return;
      if (this.stage === "AwaitQuest") {
        if (reading.quest && this.plan && reading.quest.id === this.plan.questId && reading.quest.playing) {
          // During entry the engine can expose an uninitialised origin for one sample.
          if (reading.entryReady === false || reading.players.length === 0 || reading.players.some((p) =>
            p.position.x === 0 && p.position.y === 0 && p.position.z === 0)) {
            if (reading.time - this.requestedAt > this.settings.postTimeoutSeconds)
              this.fault("玩家位置尚未初始化，无法记录集结点；请检查玩家采样接口");
            return;
          }
          if (this.nativeEnd?.unique !== reading.quest.unique) this.nativeEnd = null;
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
        this.markRunEnd(this.core.state.phase==="GameOver"?"carts-exhausted":"native-ended");
        this.core.abortRun("Quest failed");
        this.port.policy(null, false);
        if (reading.quest.playing) this.finishQuest(true, reading);
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
          this.earnedPt += this.plan!.wave.rewardPt;
          this.queueSupplies(this.plan!);
          // V1.3 §2.3：极强波清波掉落一次顶级抽取（"古龙临时毕业装备"）
          if (this.plan!.wave.tier === "ultimate" && this.port.ultimateDrop) {
            this.grantUltimateDrop();
          }
          this.stage = "Carve";
          this.clearAt = reading.time;
          this.campSince = null;
          this.message = "Wave cleared. Carve, then return to the captured starting point.";
          this.announce("wave-cleared", { token: this.plan!.token, reward: this.plan!.wave.rewardPt, resolved: this.resolved });
        } else if (reading.time - this.progressAt > (this.port.waitingForSpawnCapacity?.() ? Math.max(180, this.settings.spawnTimeoutSeconds) : this.settings.spawnTimeoutSeconds) &&
          !reading.enemies.some((enemy) => !enemy.dead && !enemy.captured && this.plan!.monsterIds.includes(enemy.typeId) && !this.excludedUids.includes(enemy.uid))) {
          if (this.route === "inPlace") {
            if (this.entryHostRun || this.multiplayerRole) { this.fault("Entry host inPlace spawn timed out; automatic reentry is unsupported"); return; }
            this.route = "reentry";
            this.retryWave = true;
            this.port.policy(this.plan, false);
            this.finishQuest(false, reading);
            this.stage = "Returning";
            this.message = "No native spawn after table replacement; falling back to quest reentry (no PT awarded)";
            this.announce("in-place-no-go", { token: this.plan!.token });
          } else if (this.plan!.sequential && this.plan!.monsterIds.length > 1 && !this.testOnly) {
            // Reentry alone cannot fix a broken HP-triggered native sequence. Publish the
            // next attempt with every target DEFAULT, so the engine starts them together.
            this.plan = { ...this.plan!, sequential: false, token: ++this.token };
            this.retryWave = true;
            this.port.policy(this.plan, false);
            this.finishQuest(false, reading);
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
    if (this.route === "inPlace" && !this.testOnly) this.generate(this.partySize(reading));
    else {
      this.port.policy(this.plan, false);
      this.finishQuest(false, reading);
      this.stage = "Returning";
      this.message = "Returning through the native quest flow; PT and carts remain in this run";
    }
  }

  private grantUltimateDrop(): void {
    if (!this.port.ultimateDrop) return;
    const drop = this.port.ultimateDrop();
    if (drop.ok && this.port.startupRestore) this.startupRestorePending = true;
    this.announce("ultimate-drop", drop);
  }

  /** Carry the already-authorized instance across the native adapter boundary.
   * The adapter must compare it to live state, never retarget to the latest quest. */
  private finishQuest(failed: boolean, reading: RuntimeReading): void {
    const q = reading.quest;
    if (!q || q.id !== this.plan?.questId || (this.questUnique !== null && q.unique !== this.questUnique))
      throw new Error("Refusing to finish a changed quest instance");
    this.port.finish(failed, { id:q.id, unique:q.unique });
  }

  private fault(error: unknown): Result {
    if (this.stage === "Fault" && this.message === String(error)) return fail(this.message);
    this.markRunEnd("fault");
    const q = this.readingSnapshot?.quest;
    if (this.readingSnapshot) {
      try { this.requestMultiplayerAbort(this.readingSnapshot, "fault"); }
      catch (guardError) { this.announce("fault-failure-guard-error", String(guardError)); }
    }
    if (this.multiplayerRole && (this.port.canFinishLocal?.() ?? this.multiplayerRole === "host") && q?.playing && this.plan?.questId === q.id &&
        (this.questUnique === null || this.questUnique === q.unique)) {
      try { this.finishQuest(true, this.readingSnapshot!); }
      catch (finishError) { this.announce("fault-finish-deferred",String(finishError)); }
    }
    this.stage = "Fault";
    this.message = String(error);
    this.port.policy(null, false);
    this.port.cancelPost();
    if (this.startupPrepared) this.startupRestorePending = true;
    this.announce("runtime-error", { error: this.message, plan: this.plan });
    return fail(this.message);
  }
}
