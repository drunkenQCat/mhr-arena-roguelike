/** Host-authoritative business state over the already-installed Steam lobby bridge.
 * Rise still owns battle packets. Native records are staged on EVERY peer and
 * compared before any peer restarts the native loading/synchronization machine. */
import { canonical } from "./wire_canonical";
export { canonical } from "./wire_canonical";
import { validateConfig, type RogueConfig } from "../core/config";
import { MultiplayerConfig,type ConfigResult } from "./multiplayer_config";
import { ConfigStore } from "./config_store";
import { validateEquipmentConfig } from "./equipment_catalog";
import { makeQuestPlan, type MonsterCatalog, type QuestPlan } from "../core/quest_plan";
import type { WaveOption, RunPhase } from "../core/run_state";
import { RUN_END_INTENTS, type RunEndIntent, type Position, type RunSession, type SessionStage } from "../core/run_session";
import type { NativeRuntime } from "./native_runtime";
import type { SpawnTicket, SpawnSync } from "./inplace_waves";
import { multiplayerScope } from "./multiplayer_scope";
import { clockSeconds, loadWebconsole, rejson, type NativeWebconsole } from "./sdk";

export interface RunContext { lobby: string; owner: string; self: string; session: string; members: string[] }
export interface RunConfigOptions { userConfig:()=>RogueConfig; store:ConfigStore }
type EncodedWave = [number, string, string[], string, number, number, number, number, string];
interface Frame { v: 4; s: string; o: string; l: string; h: string; n: number;
  rules:number;
  stage: SessionStage; phase: RunPhase; layer: number; token: number;
  w: EncodedWave; c: EncodedWave[]; earned: number; carts: number; deaths: number; cartUsed: boolean;
  camp: Position | null; killed: string[]; spawn: SpawnTicket | null; commit: boolean; endIntent?:RunEndIntent|null; }
function encode(w: WaveOption): EncodedWave { return [w.index, w.typeTag, w.monsters, w.tier, w.hpMul, w.dmgMul, w.rewardMul, w.rewardPt, w.mode ?? "single"]; }
function decode(w: EncodedWave): WaveOption {
  if (!Array.isArray(w) || w.length !== 9 || !Number.isInteger(w[0]) || w[0] < 0 || w[0] > 2 ||
      typeof w[1] !== "string" || !Array.isArray(w[2]) || w[2].length < 1 || w[2].length > 2 ||
      w[2].some(x => typeof x !== "string" || x.length > 96) || typeof w[3] !== "string" ||
      [w[4],w[5],w[6],w[7]].some(x => !Number.isFinite(x) || x < 0 || x > 1000000) ||
      !["single","sequential","simultaneous"].includes(w[8])) throw new Error("Invalid multiplayer wave");
  return { index:w[0], typeTag:w[1], monsters:w[2], tier:w[3], hpMul:w[4], dmgMul:w[5],
    rewardMul:w[6], rewardPt:w[7], mode:w[8] as WaveOption["mode"], label:`${w[8]} · ${w[2].join(" + ")}` };
}
function ticketKey(t: SpawnTicket | null): string { return t ? `${t.token}/${t.ordinal}/${t.type}/${t.slot}/${t.id}/${t.uid}` : "-"; }
function stateKey(f: Frame): string { return `${f.layer}/${f.token}/${f.stage}/${f.earned}/${f.carts}/${Number(f.cartUsed)}`; }

export class MultiplayerRun implements SpawnSync {
  readonly role: "host" | "guest";
  private hash: string;
  private configSync:MultiplayerConfig<RogueConfig>|null=null;
  private configRevision=0;
  private configEpoch=0;
  private previousHash:string|null=null;
  private previousEpoch:number|null=null;
  private changedAt=0;
  private live = true;
  private failing=false;
  private abortPending = false;
  private lastPoll = -1;
  private lastSeen = clockSeconds();
  private sequence = 0;
  private lastSequence = 0;
  private frame: Frame | null = null;
  private ticket: SpawnTicket | null = null;
  private committed = false;
  private localTicket: SpawnTicket | null = null;
  private activated: SpawnTicket | null = null;
  private stagedAt = 0;
  private preparedToken = -1;
  private members: { id: string; ack: string }[] = [];
  private publications: { sequence: number; at: number }[] = [];
  private peerHeartbeats = new Map<string, { sequence: number; at: number }>();
  private static readonly FRESH_SECONDS = 15;
  private message = "等待全队进入任务并核对配置";
  constructor(private readonly context: RunContext, private config: RogueConfig,
    private readonly catalog: MonsterCatalog, private readonly session: RunSession,
    private readonly runtime: NativeRuntime, private readonly busy: () => boolean,
    private readonly network: NativeWebconsole = loadWebconsole(),private readonly configOptions?:RunConfigOptions) {
    this.role = context.self === context.owner ? "host" : "guest";
    if (context.members.length < 2 || context.members.length > 4 || !context.members.includes(context.self) ||
        !context.members.includes(context.owner)) throw new Error("Invalid fixed multiplayer roster");
    this.hash = network.steam_digest?.(canonical(config)) ?? "";
    if (this.hash.length !== 64) throw new Error("Steam configuration digest unavailable");
    if(configOptions&&network.steam_config_payload&&network.steam_config_control&&network.steam_config_ack) {
      let original:ReturnType<RunSession["configurationSnapshot"]>|null=null,transactionOpen=false;
      const active=(user:RogueConfig)=>({...user,quest:{...user.quest,id:this.config.quest.id}});
      this.configSync=new MultiplayerConfig(context,{
        boundary:()=>({token:session.plan?.token??-1,layer:session.core.state.layer,
          ready:session.stage==="Selecting"&&session.preparation().gathered&&!this.busy()&&
            session.readingSnapshot?.quest?.playing===true&&!session.readingSnapshot.enemies.some(e=>!e.dead&&!e.captured)}),
        currentHash:()=>this.hash,
        validate:text=>{
          const user=validateConfig(rejson.load_string(text)),old=configOptions.userConfig();
          if(user.quest.id!==old.quest.id||user.quest.baseId!==old.quest.baseId||user.quest.mapNo!==old.quest.mapNo)
            throw new Error("联机配置不能改变任务身份、模板或地图");
          const next=active(user);session.validateConfigForSession(next);validateEquipmentConfig(next);
          return{value:user,effectiveHash:network.steam_digest!(canonical(session.previewConfig(next)))};
        },
        apply:user=>{
          original=session.configurationSnapshot();
          configOptions.store.begin(configOptions.userConfig(),user,`${context.session}/${this.configSync!.snapshot().serial}`);transactionOpen=true;
          session.applyConfig(active(user));this.previousHash=this.hash;this.previousEpoch=this.configEpoch;this.changedAt=clockSeconds();
          this.config=session.core.config;this.hash=network.steam_digest!(canonical(this.config));
        },
        finish:()=>configOptions.store.publish(),
        complete:()=>{configOptions.store.complete();transactionOpen=false;original=null;this.configRevision++;
          this.configEpoch=Number(this.configSync!.snapshot().serial);this.peerHeartbeats.clear();},
        restore:()=>{
          try{if(transactionOpen){configOptions.store.rollback();transactionOpen=false;}}
          finally{if(original){session.restoreConfiguration(original);this.config=session.core.config;
            this.hash=network.steam_digest!(canonical(this.config));this.previousHash=null;this.previousEpoch=null;original=null;this.configRevision++;}}
        },
        fail:reason=>this.fail(reason),
      },network);
    }
  }
  configBusy():boolean{return this.configSync?.busy()??false;}
  configurationRevision():number{return this.configRevision;}
  configResult(serial:number):ConfigResult|null{return this.configSync?.result(serial)??null;}
  proposeConfig(config:RogueConfig):number {
    if(!this.canChoose()||!this.configSync)throw new Error("请全队清波集结并更新 DLL，由房主在波间提交配置");
    return this.configSync.propose(rejson.dump_string(config,-1).split('"unlockChain":null').join('"unlockChain":[]').split('"weak":null').join('"weak":[]'));
  }
  valid(): boolean { return this.live && multiplayerScope(this.role); }
  partySize(): number { return this.context.members.length; }
  expected(): SpawnTicket | null { return this.frame?.spawn ?? null; }
  staged(ticket: SpawnTicket): void {
    if (!this.valid()) throw new Error("Multiplayer spawn scope ended");
    this.localTicket = { ...ticket }; this.activated = null;
    if (this.role === "host") {
      this.ticket = { ...ticket }; this.committed = false; this.stagedAt = clockSeconds();
      this.publish();
    }
  }
  activate(ticket: SpawnTicket): boolean {
    if (!this.valid()) throw new Error("Multiplayer spawn scope ended");
    if (this.role === "guest") {
      const ready = this.frame?.commit === true && ticketKey(this.frame.spawn) === ticketKey(ticket);
      if (ready) this.activated = { ...ticket };
      return ready;
    }
    if (ticketKey(this.ticket) !== ticketKey(ticket)) throw new Error("Spawn barrier identity changed");
    if (!this.allReady()) {
      if (clockSeconds() - this.stagedAt > 90) this.fail("队友未确认相同原生出怪记录，已停止加载");
      return false;
    }
    this.committed = true; this.activated = { ...ticket }; this.publish();
    this.message = "全队原生记录一致，启动原生加载与战斗同步";
    return true;
  }
  canStage(): boolean { return !this.configBusy()&&(!this.ticket || !this.committed || this.allReady()); }
  private ackPrefix(f: Frame, status: string): string {
    return `R4|${this.context.session}|${this.hash}:${this.configEpoch}|${stateKey(f)}|${ticketKey(this.localTicket)}|${ticketKey(this.activated)}|${status}|`;
  }
  private ack(f: Frame, status: string): string { return `${this.ackPrefix(f, status)}${f.n}`; }
  private observeHeartbeats(now: number): void {
    for (const member of this.members) {
      if (member.id === this.context.self) continue;
      const parts = member.ack.split("|");
      if (parts.length !== 8 || parts[0] !== "R4" || parts[1] !== this.context.session || parts[2] !== `${this.hash}:${this.configEpoch}`) continue;
      const sequence = Number(parts[7]);
      const published = this.publications.find(p => p.sequence === sequence);
      const previous = this.peerHeartbeats.get(member.id);
      // Only a newer echo of a recently published challenge proves a live peer.
      // Re-reading a cached lobby ACK or receiving an ancient delayed ACK is not a heartbeat.
      if (Number.isInteger(sequence) && published && now - published.at <= MultiplayerRun.FRESH_SECONDS &&
          (!previous || sequence > previous.sequence)) this.peerHeartbeats.set(member.id, { sequence, at:now });
    }
  }
  private peerReady(id: string): boolean {
    if (!this.frame) return false;
    if (id === this.context.self) return this.session.readingSnapshot?.quest?.playing === true && !this.busy();
    const member = this.members.find(m => m.id === id), heartbeat = this.peerHeartbeats.get(id);
    return !!member && !!heartbeat && clockSeconds() - heartbeat.at <= MultiplayerRun.FRESH_SECONDS &&
      member.ack.startsWith(this.ackPrefix(this.frame, "ready")) &&
      Number(member.ack.split("|")[7]) === heartbeat.sequence;
  }
  private allReady(): boolean {
    return !!this.frame && this.session.readingSnapshot?.quest?.playing === true &&
      this.context.members.every(id => this.peerReady(id));
  }
  canChoose(): boolean { return this.role === "host" && this.valid() && this.allReady() && !this.busy()&&!this.configBusy(); }
  private build(): Frame {
    const s = this.session, p = s.plan;
    if (!p) throw new Error("Multiplayer host has no active plan");
    if (this.localTicket && this.localTicket.token !== p.token) { this.localTicket = null; this.activated = null; }
    const spawn = this.ticket?.token === p.token ? this.ticket : null;
    return { v:4, s:this.context.session, o:this.context.owner, l:this.context.lobby, h:this.hash, n:++this.sequence,rules:this.configEpoch,
      stage:s.stage, phase:s.core.state.phase, layer:s.core.state.layer, token:p.token,
      w:encode(p.wave), c:s.core.state.currentChoices.map(encode), earned:s.earnedPt,
      carts:s.core.state.cartsLeft, deaths:s.readingSnapshot?.deaths ?? 0, cartUsed:s.core.state.cartRestoreUsed, camp:s.campSnapshot,
      killed:s.core.state.killedUltimates, spawn, commit:!!spawn && this.committed, endIntent:s.endingIntent };
  }
  private publish(): void {
    const f = this.build(), text = rejson.dump_string(f, -1);
    // Native bridge enforces a 2048-byte Steam value limit. Lua string length is bytes.
    if (text.length > 2048 || !this.network.steam_plan?.(this.context.lobby, text)) throw new Error("Steam rejected multiplayer state publication");
    this.frame = f;
    this.publications.push({ sequence:f.n, at:clockSeconds() });
    if (this.publications.length > 128) this.publications.shift();
  }
  private accept(text: string): void {
    let f: Frame;
    try { f = rejson.load_string(text) as Frame; } catch { return; }
    if (!f || f.v !== 4) return; // Entry prepare/post envelope until host attaches.
    if (f.s !== this.context.session || f.o !== this.context.owner || f.l !== this.context.lobby) throw new Error("Multiplayer session identity changed");
    if (!Number.isInteger(f.n) || f.n <= this.lastSequence) return;
    if(!Number.isInteger(f.rules)||f.rules<0)throw new Error("联机配置代号无效，请全队更新相同版本");
    if(f.rules!==this.configEpoch){
      if(f.rules===this.previousEpoch&&clockSeconds()-this.changedAt<=120)return;
      throw new Error("联机配置代号不一致，停止加载");
    }
    if (f.h !== this.hash) {
      if(f.h===this.previousHash&&clockSeconds()-this.changedAt<=120)return;
      throw new Error("房主与本机配置不一致；请安装同一 Nightly 并同步配置后重新开局");
    }
    this.previousHash=null;this.previousEpoch=null;
    if (!Number.isInteger(f.layer) || f.layer < 1 || !Number.isInteger(f.token) || f.token < 0 ||
        !Number.isInteger(f.deaths) || f.deaths < 0 || !Number.isInteger(f.earned) || f.earned < 0 || !Number.isInteger(f.carts) || f.carts < 0 || f.carts > this.config.maxCarts ||
        !["AwaitQuest","Combat","Carve","Selecting","Finished","Fault"].includes(f.stage) ||
        (f.endIntent != null && (!RUN_END_INTENTS.includes(f.endIntent) || !["Finished","Fault"].includes(f.stage))) ||
        !["Prep","Choosing","Combat","Carve","GameOver"].includes(f.phase) ||
        (f.camp !== null && (!f.camp || ![f.camp.x,f.camp.y,f.camp.z].every(x => Number.isFinite(x))))) throw new Error("Invalid multiplayer state");
    const wave = decode(f.w), choices = (f.c ?? []).map(decode);
    if (choices.length > 3 || (this.frame && (f.token < this.frame.token || f.layer < this.frame.layer))) throw new Error("Multiplayer state moved backwards");
    const plan = makeQuestPlan(this.config, this.catalog, wave, f.layer, f.token, wave.mode === "sequential");
    if (f.spawn && (!Number.isInteger(f.spawn.ordinal) || f.spawn.ordinal < 0 || f.spawn.ordinal >= plan.monsterIds.length ||
        f.spawn.token !== f.token || f.spawn.type !== plan.monsterIds[f.spawn.ordinal] ||
        !Number.isInteger(f.spawn.slot) || f.spawn.slot < 2 || f.spawn.slot > 6 ||
        !Number.isInteger(f.spawn.id) || f.spawn.id < 0 || !Number.isInteger(f.spawn.uid) || f.spawn.uid < 0)) throw new Error("Invalid multiplayer spawn ticket");
    const reading = this.session.readingSnapshot;
    if (!reading?.quest || (!reading.quest.playing && !["Finished","Fault"].includes(f.stage))) return;
    if (reading.quest.id !== plan.questId || (this.session.questUniqueSnapshot !== null &&
        reading.quest.unique !== this.session.questUniqueSnapshot)) throw new Error("Guest native quest instance changed");
    const terminal = ["Finished", "Fault"].includes(f.stage);
    if (this.preparedToken !== f.token && f.layer > 1 && f.stage === "Combat") {
      // Native death delivery can lag host state; wait rather than destroying a live actor.
      if (reading.enemies.some(e => !e.dead && !e.captured) || this.busy()) return;
      this.runtime.publish(plan, true); this.localTicket = null; this.activated = null; this.preparedToken = f.token;
    }
    // A pending/unknown purchase freezes gameplay, never the host's ending.
    // Ending frames carry accounting and intent, not late native service writes.
    if (!terminal && this.busy() && stateKey(f) !== (this.frame ? stateKey(this.frame) : "")) return;
    if (!terminal && f.cartUsed && !this.session.core.state.cartRestoreUsed) this.runtime.mirrorCartRestore(f.deaths);
    this.session.mirrorMultiplayer({ stage:f.stage, phase:f.phase, layer:f.layer, plan, choices,
      earned:f.earned, carts:f.carts, cartUsed:f.cartUsed, camp:f.camp, killed:f.killed ?? [], endIntent:f.endIntent });
    this.frame = f; this.lastSequence = f.n; this.lastSeen = clockSeconds();
    this.message = f.stage === "Fault" ? "房主已停止本局，请下载双方日志" : f.stage === "Finished" ? "房主已结束本局" : "已跟随房主；个人余额与背包保留";
  }
  tick(): void {
    const now = clockSeconds();
    if ((!this.live && !this.abortPending) || this.lastPoll === now) return;
    this.lastPoll = now;
    // Native return can finish locally before the last Steam frame or lobby teardown.
    // Never turn an already-ended local run back into a synchronization fault.
    if (["Finished", "Fault"].includes(this.session.stage)) {
      this.configSync?.shutdown("原生任务已结束，撤销尚未完成的配置事务");
      if (this.role === "host") { try { this.publish(); } catch { /* native lobby may already be retired */ } }
      else this.publishAbort();
      this.live = false; this.message = "本局已结束，等待回村恢复后重新开局";
      return;
    }
    try {
      if (!this.valid()) throw new Error("原生任务或房主身份发生变化");
      const snapshot = this.network.steam_snapshot?.();
      const lobby = snapshot?.lobbies?.find(l => l.id === this.context.lobby && l.owner === this.context.owner && l.self === this.context.self);
      if (!lobby || lobby.members.map(m => m.id).sort().join(",") !== [...this.context.members].sort().join(",")) throw new Error("固定队伍改变；暂不支持中途加入、离开或房主迁移");
      this.members = lobby.members;
      this.configSync?.tick();
      if(!this.live)return;
      if(this.configBusy()){this.lastSeen=now;return;} // independent barrier owns its bounded timeout
      if (this.role === "host") {
        if (this.members.some(m => m.id !== this.context.self && m.ack.startsWith(`R4ERR|${this.context.session}|stop|`))) {
          this.session.stop(); this.publish(); this.live = false;
          this.message = "队友已请求停止本局，等待原生失败回村与个人恢复";
          this.runtime.report("multiplayer-run-stopped", { role:this.role, requestedBy:"guest" });
          return;
        }
        if (this.members.some(m => m.ack.startsWith(`R4ERR|${this.context.session}|`))) throw new Error("队友同步失败，请下载双方日志");
        this.observeHeartbeats(now);
        this.publish();
        if (this.allReady()) this.lastSeen = now;
        if (now - this.lastSeen > 120) throw new Error("等待队友同步超过120秒");
      } else this.accept(lobby.plan);
      if (now - this.lastSeen > 120) throw new Error("房主状态超过120秒未更新");
      if (this.frame) {
        const entered = this.session.readingSnapshot?.quest?.playing === true;
        this.network.steam_ack?.(this.context.lobby, this.ack(this.frame, entered && !this.busy() ? "ready" : "waiting"));
        if (["Finished","Fault"].includes(this.frame.stage)) this.live = false;
      }
    } catch (e) { this.fail(String(e)); }
  }
  fail(reason: string): void {
    if (!this.live||this.failing) return;
    this.failing=true;
    try {
      this.configSync?.shutdown(reason);
      this.message = reason;
      // NativeRuntime still needs this live authority while it queues the
      // owned quest's failure. The recursion guard is separate from liveness.
      if (this.role === "host") { try { this.session.failMultiplayer(reason); this.publish(); } catch { /* scope may already be gone */ } }
      else { this.session.failMultiplayer(reason); this.publishAbort(); }
      this.runtime.report("multiplayer-run-error", { role:this.role, reason });
    }finally{this.live=false;this.failing=false;}
  }
  private publishAbort(): void {
    this.abortPending = this.session.multiplayerAbortPending;
    if (!this.abortPending) return;
    // The persistent member value is retried while this exact local quest is live.
    // A failed publication must not strand the host until its 120-second timeout.
    try {
      this.network.steam_ack?.(this.context.lobby, `R4ERR|${this.context.session}|${this.session.multiplayerAbortKind}|${this.session.message.slice(0,256)}`);
    } catch { /* Retry on the next poll; native return cancels the pending intent. */ }
  }
  snapshot(): Record<string, unknown> { return { role:this.role, live:this.live, message:this.message,
    configSync:this.configSync?.snapshot()??null,configRevision:this.configRevision,
    configEpoch:this.configEpoch,
    fixedPartySize:this.partySize(),
    lobby:this.context.lobby, session:this.context.session, members:this.members.map(m => ({ id:m.id, self:m.id === this.context.self,
      ready:this.role === "host" ? this.peerReady(m.id) : !!this.frame && m.ack.startsWith(this.ackPrefix(this.frame,"ready")) })),
    token:this.frame?.token ?? null, staged:this.localTicket, commit:this.committed }; }
}
