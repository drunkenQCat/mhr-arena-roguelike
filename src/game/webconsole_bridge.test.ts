import { createHash } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { validateConfig } from "../core/config";
import { RunCore } from "../core/run_core";
import { RunSession, type RuntimeReading, type SessionPort } from "../core/run_session";
import type { NativeRuntime } from "./native_runtime";
import { ShopWindow } from "./shop_window";
const wardrobe=vi.hoisted(()=>({version:"run-1:0",wear:vi.fn(),socket:vi.fn()}));
vi.mock("./equip_wear",()=>({runEquipmentSnapshot:()=>({version:wardrobe.version,items:[],jewels:[],reason:null}),
 wearRunEquipment:(...args:unknown[])=>wardrobe.wear(...args),socketRunJewel:(...args:unknown[])=>wardrobe.socket(...args)}));

const host = vi.hoisted(() => ({ now: 10, files: {} as Record<string, any>, count: 0, failWrite: "", commands: [] as string[], equipmentError:false, deferEquipment:false, nativeWork:[] as {key:object,run:()=>void}[] }));
vi.mock("./equipment_update", () => ({
 enqueueEquipmentWork: (key:object,run:()=>void) => {if(host.deferEquipment)host.nativeWork.push({key,run});else run();},
 cancelEquipmentWork: (key:object) => {host.nativeWork=host.nativeWork.filter(w=>w.key!==key);}, inEquipmentUpdate: () => true,
}));
vi.mock("./equipment_catalog",()=>({validateEquipmentConfig:()=>{if(host.equipmentError)throw new Error("gachaPools.gacha_1.entries[0].id：游戏中没有此装备");}}));
vi.mock("./sdk", () => ({ loadWebconsole: () => ({
  epoch: () => 1, steam_digest:(text:string)=>createHash("sha256").update(text).digest("hex"),
  take_commands: (limit: number) => host.commands.splice(0, limit),
  publish_state: (text: string) => { host.files["webconsole_state.json"] = JSON.parse(text); },
  publish_results: (text: string) => { if (host.failWrite === "webconsole_results.json") throw new Error("publish failed"); host.files["webconsole_results.json"] = JSON.parse(text); }
}), clockSeconds: () => host.now, getSingleton: () => null,
  refFs: { read: (path: string) => host.files[path] === undefined ? "" : JSON.stringify(host.files[path]),
    write: (path: string, text: string) => { if (path !== host.failWrite) host.files[path] = JSON.parse(text); } },
  rejson: { dump_string: (body: unknown) => JSON.stringify(body), load_string: (s: string) => { try { return JSON.parse(s); } catch { return null; } },
    dump_file: (path: string, body: unknown) => { if (path === host.failWrite) return false; host.files[path] = JSON.parse(JSON.stringify(body)); return true; } }, imguiApi: {} }));
vi.mock("./item_grant", () => ({ canTrade: () => true, pouchCanReceive: () => true, pouchCount: () => host.count,
  grantItem: () => ({ granted: true, before: host.count++, after: host.count }), grantFill: vi.fn() }));
vi.mock("./native_cart", () => ({ restoreNativeCart: vi.fn() }));
import { WebConsoleBridge } from "./webconsole_bridge";

function fixture() {
  const cfg = validateConfig(JSON.parse(readFileSync(new URL("../../data/rogue_config.json", import.meta.url), "utf8")));
  cfg.runtime = { ...cfg.runtime!, route: "inPlace", carveSeconds: 2, campDwellSeconds: 1 };
  const core = new RunCore(cfg, 42);
  let reading: RuntimeReading = { time: host.now, quest: null, players: [{ id: 0, position: { x: 10, y: 20, z: 30 } }],
    enemies: [], online: false, deaths: 0, canPost: true };
  const port: SessionPort = { now: () => host.now, ready: () => true, read: () => reading,
    publish() {}, policy() {}, post() {}, cancelPost() {}, postingError: () => null, finish() {}, takeDeaths: () => [], report() {} };
  const session = new RunSession(core, { Izuchi: { id: 98, cn: "镰鼬龙王" },
    ...JSON.parse(readFileSync(new URL("../../data/monster_ids.json", import.meta.url), "utf8")) }, port);
  const tools = { invincible: false, message: "ok", toggleGod: vi.fn(() => { tools.invincible = !tools.invincible; }), requestKill: vi.fn() };
  const runtime = { ready: () => true, status: () => "ready", testTools: tools, teleportPlayer: vi.fn(),
    combatPreparation:()=>({state:'inactive',pending:false,reason:'',held:0,identity:null}),continueCombatPreparation:()=>false,
    nearestAliveMonsterPosition: vi.fn(() => ({ x: 100, y: 5, z: 80 })) } as unknown as NativeRuntime;
  const shop = new ShopWindow(core, () => session.canShop(), () => session.shopQuest());
  const bridge = new WebConsoleBridge(session, runtime, shop);
  function tick() { host.now++; reading.time = host.now; session.tick(); for (let i = 0; i < 12; i++) bridge.tick(); }
  function command(cmd: string, extra: Record<string, unknown> = {}, id = `${cmd}-${host.now}`) {
    host.commands.push(JSON.stringify({ id, bridgeId: bridge.bridgeId,
      questUnique: reading.quest?.unique ?? null, waveToken: session.plan?.token ?? null, cmd, ...extra }));
    tick(); return host.files["webconsole_results.json"]?.last;
  }
  const state = () => host.files["webconsole_state.json"];
  return { cfg, core, session, runtime, tools, shop, bridge, command, tick, state, reading };
}
beforeEach(() => { host.now = 10; host.files = {}; host.count = 0; host.failWrite = ""; host.commands = []; host.equipmentError=false; host.deferEquipment=false;host.nativeWork=[]; });
beforeEach(()=>{wardrobe.version="run-1:0";wardrobe.wear.mockClear();wardrobe.socket.mockClear();});
it("checks run wardrobe versions and personal preparation on the game side",()=>{
 const f=fixture();vi.spyOn(f.session,"canShop").mockReturnValue(true);
 expect(f.command("equipment",{sub:"wear",equipmentKey:21,equipmentVersion:"run-1:0"}).status).toBe("applied");
 expect(wardrobe.wear).toHaveBeenCalledWith(21);
 expect(f.command("equipment",{sub:"wear",equipmentKey:22,equipmentVersion:"previous-run:0"}).status).toBe("rejected");
 expect(wardrobe.wear).toHaveBeenCalledTimes(1);
});
it("rechecks preparation after a wardrobe command waits in the native queue",()=>{
 const f=fixture(),allowed=vi.spyOn(f.session,"canShop").mockReturnValue(true);host.deferEquipment=true;
 f.command("equipment",{sub:"socket",equipmentKey:21,equipmentVersion:"run-1:0",socket:0,jewelId:13});
 expect(wardrobe.socket).not.toHaveBeenCalled();allowed.mockReturnValue(false);host.nativeWork.shift()!.run();
 expect(wardrobe.socket).not.toHaveBeenCalled();expect(host.files["webconsole_results.json"].last.status).toBe("rejected");
});

it("keeps saved rules and version intact when the installed game rejects equipment data",()=>{
 const f=fixture();host.equipmentError=true;
 const reply=f.command("submitConfig",{config:{...f.cfg,startPt:321},configVersion:0});
 expect(reply.status).toBe("rejected");expect(reply.message).toContain("gachaPools.gacha_1.entries[0].id");
 expect(host.files["mhw_rogue_config.json"]).toBeUndefined();expect(f.session.configForEditing().startPt).toBe(f.cfg.startPt);
 host.equipmentError=false;
 expect(f.command("submitConfig",{config:{...f.cfg,startPt:321},configVersion:0}).configVersion).toBe(1);
});
it("keeps a multiplayer config receipt queued until the barrier completes and increments the local version on guests",()=>{
 const f=fixture();let role:"host"|"guest"="host",revision=0,finished=false;
 Object.assign((f.session as any).port,{multiplayerRole:()=>role,multiplayerValid:()=>true});
 Object.assign(f.runtime,{multiplayerConfigRevision:()=>revision,multiplayerConfigBusy:()=>!finished&&revision>0,
  submitMultiplayerConfig:vi.fn(()=>7),multiplayerConfigResult:()=>finished?{serial:7,status:"applied",message:"all peers persisted"}:null});
 const receipt=f.command("submitConfig",{config:f.cfg,configVersion:0},"mp-config");
 expect(receipt.status).toBe("queued");expect(f.bridge.configVersion).toBe(0);expect(host.files["mhw_rogue_config.json"]).toBeUndefined();
 finished=true;revision=1;f.tick();expect(host.files["webconsole_results.json"].last).toMatchObject({id:"mp-config",status:"applied",configVersion:1});
 const fp=host.files["webconsole_results.json"].last.__fp;expect(fp).toHaveLength(64);
 role="guest";revision=2;f.tick();expect(f.bridge.configVersion).toBe(2);
});
it("rejects stale config task identity before asking the multiplayer coordinator",()=>{
 const f=fixture();const submit=vi.fn();Object.assign(f.runtime,{submitMultiplayerConfig:submit});
 expect(f.command("submitConfig",{config:f.cfg,configVersion:0,questUnique:999},"old-task").status).toBe("rejected");expect(submit).not.toHaveBeenCalled();
});
it("invalidates planner drafts after configuration recovery even without a Lua reset",()=>{
 const f=fixture();f.tick();expect(f.bridge.configVersion).toBe(0);f.session.configurationRecovered();f.tick();
 expect(f.bridge.configVersion).toBe(1);
 expect(f.command("submitConfig",{config:f.cfg,configVersion:0},"stale-before-recovery").status).toBe("rejected");
});

it("publishes authoritative controls and preserves route changes after staged rules", () => {
  const f = fixture(); f.tick();
  expect(f.state().control.ready).toBe(true);
  expect(f.state().capabilities.start).toBe(true);
  expect(f.state().control.testLayers).toEqual(f.cfg.pools.map(p => p.from));
  f.session.applyConfig({ ...f.cfg, runtime: { ...f.cfg.runtime!, route: 'inPlace' } });
  expect(f.command('setRoute', { route: 'reentry' }).status).toBe('applied');
  f.tick();
  expect(f.state().control.nextRoute).toBe('reentry');
  expect(f.command('startRun', { armor: f.cfg.armorOptions[0] }).status).toBe('applied');
  expect(f.session.route).toBe('reentry');
});

it("publishes start/stop state before their receipts even within the same sampled second",()=>{
 const f=fixture();f.tick();const timestamp=host.now;
 const send=(cmd:string)=>{
  host.commands.push(JSON.stringify({id:`instant-${cmd}`,bridgeId:f.bridge.bridgeId,cmd,armor:f.cfg.armorOptions[0],questUnique:null,waveToken:null}));
  for(let i=0;i<12;i++)f.bridge.tick();
  expect(host.files['webconsole_results.json'].last.status).toBe('applied');
 };
 send('startRun');expect(f.state().sessionStage).toBe('Selecting');
 send('stop');expect(f.state().sessionStage).toBe('Finished');expect(host.now).toBe(timestamp);
});
it("publishes failed-effect state before a rejected receipt within the same sampled second",()=>{
 const f=fixture();let state="reserved";
 f.bridge.designer={snapshot:()=>({orders:[{state}]}),command:()=>{state="failed";return {ok:false,message:"confirmed zero delivery",order:{state}};}} as any;
 f.tick();expect(f.state().designerEffects.orders[0].state).toBe("reserved");const timestamp=host.now;
 host.commands.push(JSON.stringify({id:"instant-effect-failure",bridgeId:f.bridge.bridgeId,cmd:"designerEffects",sub:"buy",questUnique:null,waveToken:null}));
 for(let i=0;i<12;i++)f.bridge.tick();
 expect(host.files['webconsole_results.json'].last.status).toBe('rejected');
 expect(f.state().designerEffects.orders[0].state).toBe('failed');expect(host.now).toBe(timestamp);
});
it('keeps multiplayer purchases queued until host and buyer receipts settle, including cached replays',()=>{
 const f=fixture();let result:any=null;const command=vi.fn(()=>({ok:true,pending:true,message:'waiting for owner permit'}));
 f.bridge.designer={snapshot:()=>({orders:result?[result.order]:[]}),command,commandResult:()=>result} as any;
 const id='async-effect';expect(f.command('designerEffects',{sub:'buy'},id).status).toBe('queued');
 expect(f.command('designerEffects',{sub:'buy'},id).status).toBe('queued');expect(command).toHaveBeenCalledOnce();
 result={ok:true,message:'frozen and reserved locally',order:{state:'reserved'}};f.tick();
 expect(host.files['webconsole_results.json'].last).toMatchObject({id,status:'applied'});
 expect(f.command('designerEffects',{sub:'buy'},id).status).toBe('applied');expect(command).toHaveBeenCalledOnce();
});
it('publishes an uncertain multiplayer execution without manufacturing an order or retrying it',()=>{
 const f=fixture();let result:any=null;const command=vi.fn(()=>({ok:true,pending:true,message:'waiting'}));
 f.bridge.designer={snapshot:()=>({orders:[]}),command,commandResult:()=>result} as any;
 f.command('designerEffects',{sub:'buy'},'uncertain-network');result={ok:false,uncertain:true,message:'reply disappeared after native attempt'};f.tick();
 expect(host.files['webconsole_results.json'].last.status).toBe('uncertain');expect(command).toHaveBeenCalledOnce();
});
it('keeps a completed native save visible before allowing business bridge retirement',()=>{
 const f=fixture();let result:any=null;const request=vi.fn(()=>1);
 f.bridge.nativeSave={request,requestResult:()=>result} as any;
 expect(f.command('saveGame',{},'save-before-replacement').status).toBe('queued');expect(f.bridge.replacementReady()).toBe(false);
 result={status:'applied',message:'actual character and callback verified',slot:0,characterSaved:true};f.tick();
 expect(host.files['webconsole_results.json'].last).toMatchObject({id:'save-before-replacement',status:'applied',characterSaved:true});
 expect(f.bridge.replacementReady()).toBe(false);host.now+=2;expect(f.bridge.replacementReady()).toBe(true);
 expect(f.command('saveGame',{},'save-before-replacement').status).toBe('applied');expect(request).toHaveBeenCalledOnce();
});

it("rejects unsupported test layers before preparing the run", () => {
  const f = fixture(); f.tick();
  const start = vi.spyOn(f.session, 'start');
  expect(f.command('startRun', { armor: f.cfg.armorOptions[0], testLayer: 999999 }).status).toBe('rejected');
  expect(start).not.toHaveBeenCalled();
  expect(f.session.stage).toBe('Idle');
});

it("updates wave, position, gathering and shop eligibility with no PT change at preparation", () => {
  const f = fixture(); f.tick(); f.session.start(f.cfg.armorOptions[0]!); f.tick();
  expect(f.state().shopAvailable).toBe(true);
  const choice = f.core.state.currentChoices.find((c) => c.monsters.length === 1)!;
  expect(f.command("choose", { index: choice.index }).status).toBe("applied");
  f.reading.quest = { id: f.cfg.quest.id, unique: 42, playing: true, status: "play" }; f.reading.canPost = false; f.tick();
  f.reading.enemies = [{ uid: 9, typeId: f.session.plan!.monsterIds[0]!, dead: true, captured: false }]; f.tick();
  expect(f.state().sessionStage).toBe("Carve"); expect(f.state().shopAvailable).toBe(false);
  const pt = f.state().pt;
  f.reading.players[0]!.position = { x: 200, y: 20, z: 30 }; f.tick(); f.tick();
  expect(f.state().preparation.players[0].campDistance).toBe(190);
  f.reading.players[0]!.position = { x: 10, y: 20, z: 30 }; f.tick(); f.tick();
  expect(f.state().pt).toBe(pt); expect(f.state().layer).toBe(2);
  expect(f.state().sessionStage).toBe("Selecting"); expect(f.state().shopAvailable).toBe(true);
  expect(f.state().shop["基础补给"].find((e: any) => e.id === "potion").canBuy).toBe(true);
  f.reading.players[0]!.position.x = 200; f.tick();
  expect(f.state().shopAvailable).toBe(false);
});

it("refreshes actual inventory even when PT, phase and config stay unchanged", () => {
  const f = fixture(); f.tick(); f.session.start(f.cfg.armorOptions[0]!); f.tick();
  host.count = 10; f.tick();
  const potion = () => f.state().shop["基础补给"].find((e: any) => e.id === "potion");
  expect(potion().canBuy).toBe(false); host.count = 2; f.tick();
  expect(potion().owned).toBe(2); expect(potion().canBuy).toBe(true);
});

it("replaces a queued purchase receipt with the verified transaction result", () => {
  const f = fixture(); f.tick(); f.session.start(f.cfg.armorOptions[0]!); f.tick();
  const before = f.core.state.wallet.pt;
  expect(f.command("buy", { itemId: "potion" }, "purchase-1").status).toBe("queued");
  f.shop.tick(); f.tick();
  const receipt = host.files["webconsole_results.json"].history.find((r: any) => r.id === "purchase-1");
  expect(receipt.status).toBe("applied"); expect(f.core.state.wallet.pt).toBe(before - 10);
  expect(f.command("buy", { itemId: "potion" }, "purchase-1").status).toBe("applied");
  f.shop.tick(); expect(f.core.state.wallet.pt).toBe(before - 10);
});

it("rejects stale or missing session identities, writes the matching receipt and consumes the slot", () => {
  const f = fixture(); f.tick();
  expect(f.command("setInvincible", { bridgeId: "old", value: true }).status).toBe("rejected");
  expect(f.tools.toggleGod).not.toHaveBeenCalled();
  expect(host.commands).toEqual([]);
  expect(f.command("killAll", { questUnique: 999 }).message).toContain("任务实例");
});

it("deduplicates requests across intervening commands and failed receipt writes", () => {
  const f = fixture(); f.tick();
  host.failWrite = "webconsole_results.json";
  f.command("setInvincible", { value: true }, "once"); f.tick();
  expect(f.tools.toggleGod).toHaveBeenCalledTimes(1);
  host.failWrite = ""; f.tick(); f.command("getConfig"); f.command("setInvincible", { value: true }, "once");
  expect(f.tools.toggleGod).toHaveBeenCalledTimes(1);
});

it("returns authoritative config and rejects conflicts or failed persistence without mutating it", () => {
  const f = fixture(); f.tick();
  host.files["mhw_rogue_config.json"] = { startPt: 999 };
  expect(f.command("getConfig").config.startPt).toBe(f.cfg.startPt);
  const edited = { ...f.cfg, startPt: 250 };
  expect(f.command("submitConfig", { config: edited, configVersion: 9 }).status).toBe("rejected");
  host.failWrite = "mhw_rogue_config.json";
  expect(f.command("submitConfig", { config: edited, configVersion: 0 }).status).toBe("rejected");
  expect(f.core.config.startPt).toBe(f.cfg.startPt);
  host.failWrite = "";
  expect(f.command("submitConfig", { config: edited, configVersion: 0 }).configVersion).toBe(1);
});

it("freezes run rules and the current wave, but stages new rules for the next run", () => {
  const f = fixture(); f.tick(); f.session.start(f.cfg.armorOptions[0]!); f.tick();
  f.session.choose(0); const wave = f.core.state.activeWave;
  const edited = { ...f.cfg, startPt: 999, maxCarts: 8, scaling: { ...f.cfg.scaling, hpBase: 0.9 } };
  expect(f.command("submitConfig", { config: edited, configVersion: 0 }).status).toBe("applied");
  expect(f.core.config.maxCarts).toBe(f.cfg.maxCarts); expect(f.core.state.activeWave).toBe(wave);
  expect(f.core.config.scaling.hpBase).toBe(0.9);
  f.session.stop(); f.tick(); expect(f.session.start(f.cfg.armorOptions[0]!).ok).toBe(true);
  expect(f.core.state.wallet.pt).toBe(999); expect(f.core.state.cartsLeft).toBe(8);
});

it("rejects village and stale TP; deduplicates a native task origin request", () => {
  const f = fixture(); f.tick();
  expect(f.command("teleport", { to: "origin" }).status).toBe("rejected");
  f.session.start(f.cfg.armorOptions[0]!); f.tick();
  const choice = f.core.state.currentChoices.find(c => c.monsters.length === 1)!;
  f.command("choose", { index: choice.index });
  f.reading.quest = { id: f.cfg.quest.id, unique: 42, playing: true, status: "play" };
  f.reading.canPost = false;
  f.reading.enemies = [{ uid: 9, typeId: f.session.plan!.monsterIds[0]!, hp: 100, maxHp: 100 }]; f.tick();
  expect(f.command("teleport", { to: "origin", questUnique: 999 }).status).toBe("rejected");
  expect(f.runtime.teleportPlayer).not.toHaveBeenCalled();
  const r = f.command("teleport", { to: "origin" }, "tp-once");
  expect(r.status).toBe("queued"); expect(r.target).toEqual({ x: 10, y: 20, z: 30 });
  f.command("teleport", { to: "origin" }, "tp-once");
  expect(f.runtime.teleportPlayer).toHaveBeenCalledTimes(1);
  expect(f.command("teleport", { to: "monster" }).target).toEqual({ x: 104, y: 5, z: 80 });
});

function combatFixture() {
 const f=fixture(); f.tick(); f.session.start(f.cfg.armorOptions[0]!); f.tick();
 f.session.choose(0); f.reading.quest={id:f.cfg.quest.id,unique:42,playing:true,status:"play"};
 f.reading.canPost=false;f.reading.enemies=[{uid:9,typeId:f.session.plan!.monsterIds[0]!,dead:false,captured:false}];f.tick();return f;
}
it("settles kill receipt only after the requested targets have native death evidence",()=>{
 const f=combatFixture();expect(f.command("killAll",{},"kill-verified").status).toBe("queued");
 f.reading.enemies[0]!.dead=true;f.tick();
 expect(host.files["webconsole_results.json"].last.status).toBe("applied");expect(f.tools.requestKill).toHaveBeenCalledTimes(1);
});
it("settles TP from later position evidence and marks an unverified kill uncertain",()=>{
 const f=combatFixture();expect(f.command("teleport",{to:"monster"},"move").status).toBe("queued");
 f.reading.players[0]!.position={x:104,y:5,z:80};f.tick();
 expect(host.files["webconsole_results.json"].last.status).toBe("applied");
 expect(f.command("killAll",{},"kill-timeout").status).toBe("queued");host.now+=13;f.tick();
 expect(host.files["webconsole_results.json"].last.status).toBe("uncertain");
});

// ---------- 评审二轮（2026-10-31）针对性回归 ----------

it("REVIEW2#1: reset 后旧 id 购买不再命中缓存/扣款（generation 门禁）", () => {
  const f = fixture(); f.tick();
  const gen1 = f.command("party", { sub: "create", mockPlayers: 1 }, "r-create1");
  expect(gen1.status).toBe("applied");
  const generation = (gen1.businessParty as any).generation;
  const buy = f.command("party", { sub: "buy", playerId: "p2", itemId: "potion", generation }, "old-buy");
  expect(buy.status).toBe("applied"); expect(buy.playerPt).toBe(140);
  f.command("party", { sub: "reset" }, "r-reset");
  f.command("party", { sub: "create", mockPlayers: 1 }, "r-create2");
  // 旧 generation 查询被拒绝（不能泄露新一代身份到旧代请求的回执里）。
  const staleState = f.command("party", { sub: "state", generation }, "r-state2");
  expect(staleState.status).toBe("rejected");
  // 当前代从 state 顶层 partyGeneration 读取（CLI 同款通道）。
  f.tick();
  const generation2 = f.state().partyGeneration;
  expect(generation2).toBe(generation + 1);
  // 旧 id 旧 generation（重放者不自知）：服务端按旧代拒绝——不再回放旧成功。
  const stale = f.command("party", { sub: "buy", playerId: "p2", itemId: "potion", generation }, "old-buy");
  expect(stale.status).toBe("rejected"); expect(stale.message).toContain("已更换");
  // 缺 generation 的旧客户端：拒绝。
  const noGen = f.command("party", { sub: "buy", playerId: "p2", itemId: "potion" }, "old-buy");
  expect(noGen.status).toBe("rejected"); expect(noGen.message).toContain("generation");
  // 当前代新请求才有效。
  const cur = f.command("party", { sub: "buy", playerId: "p2", itemId: "potion", generation: generation2 }, "fresh-buy");
  expect(cur.status).toBe("applied");
  const view = f.command("party", { sub: "state", playerId: "p2", generation: generation2 }, "read-current");
  expect((view.businessParty as any).members[0].wallet.pt).toBe(140);
});

it("REVIEW2#2: 同 id 异载荷后端拒绝（传输 id 唯一契约）", () => {
  const f = fixture(); f.tick();
  const gen = f.command("party", { sub: "create", mockPlayers: 1 }, "c1");
  const g = (gen.businessParty as any).generation;
  expect(f.command("party", { sub: "state", playerId: "p2", generation: g }, "same-id").status).toBe("applied");
  const conflict = f.command("party", { sub: "state", playerId: "host", generation: g }, "same-id");
  expect(conflict.status).toBe("rejected");
  expect(conflict.message).toContain("传输 id 必须唯一");
});

it("REVIEW2#2: 失效 bridge 请求在缓存窗口内也被拒绝", () => {
  const f = fixture(); f.tick();
  const gen = f.command("party", { sub: "create", mockPlayers: 1 }, "c2");
  const g = (gen.businessParty as any).generation;
  expect(f.command("party", { sub: "state", playerId: "p2", generation: g }, "sb-1").status).toBe("applied");
  host.commands.push(JSON.stringify({ id: "sb-1", bridgeId: "stale-bridge",
    questUnique: null, waveToken: null, cmd: "party", sub: "state", playerId: "host", generation: g }));
  f.tick();
  const last = host.files["webconsole_results.json"].last;
  expect(last.status).toBe("rejected");
});

it("REVIEW2#3: submitConfig 同 id 异载荷拒绝（config/configVersion 入指纹）", () => {
  const f = fixture(); f.tick();
  const edited250 = { ...f.cfg, startPt: 250 };
  expect(f.command("submitConfig", { config: edited250, configVersion: 0 }, "same-config-id").status).toBe("applied");
  const replay = f.command("submitConfig", { config: { ...f.cfg, startPt: 350 }, configVersion: 1 }, "same-config-id");
  expect(replay.status).toBe("rejected");
  expect(f.session.configForEditing().startPt).toBe(250);
});

it("REVIEW2#4: expired 墓碑有界（容量上限）且 reset 清空", () => {
  const f = fixture();
  const p = (f.bridge as any).party;
  p.create("host", 1);
  const gen = p.summary().generation;
  for (let i = 0; i < 1000; i++) p.buy("p2", `bad-${i}`, "unknown-item", gen);
  p.prune(host.now + 601);
  expect(p.dedupe.size).toBe(0);
  expect(p.expired.size).toBeLessThanOrEqual(4096);
  p.reset();
  expect(p.expired.size).toBe(0); // reset 清墓碑
});

it("does not let automatic result steps replace the external command receipt",()=>{
 const f=fixture();f.tick();const receipt=f.command("setRoute",{route:"inPlace"},"external-return");
 const ui=(f.bridge as unknown as {nativeUi:{poll():unknown}}).nativeUi;
 vi.spyOn(ui,"poll").mockReturnValue({id:"return-7-1",internal:true,status:"applied"});
 f.tick();expect(host.files["webconsole_results.json"].last.id).toBe(receipt.id);
});


it("verifies multiplayer teleport against the local guest and preserves arrival evidence across a faint", () => {
 const f=fixture();f.session.start(f.cfg.armorOptions[0]!);f.session.choose(0);
 f.reading.quest={id:f.cfg.quest.id,unique:42,playing:true,status:"play"};f.reading.canPost=false;f.tick();
 f.reading.online=true;f.reading.localPlayerId=1;
 Object.assign((f.session as any).port,{multiplayerRole:()=>"guest",multiplayerValid:()=>true});
 Object.assign(f.runtime,{multiplayerValid:()=>true});
 f.reading.players=[{id:0,position:{x:104,y:5,z:80}},{id:1,position:{x:10,y:50,z:47}}];
 const receipt=f.command("teleport",{to:"monster"},"guest-warp");expect(receipt.status).toBe("queued");
 f.tick();expect(host.files["webconsole_results.json"].last.status).toBe("queued");
 f.reading.players[1]!.position={x:104,y:5,z:80};f.tick();
 expect(host.files["webconsole_results.json"].last).toMatchObject({status:"applied",position:{x:104,y:5,z:80},verifiedAt:host.now});
 f.reading.players[1]!.position={x:0,y:50,z:47};f.tick();
 expect(host.files["webconsole_results.json"].last.position).toEqual({x:104,y:5,z:80});
});

it("rejects same-ID nested rule changes even when counts, start PT and carts match",()=>{
 const f=fixture();f.tick();const initial=structuredClone(f.cfg);
 expect(f.command("submitConfig",{config:initial,configVersion:0},"nested-config").status).toBe("applied");
 const changed={...initial,buffAmounts:{...initial.buffAmounts!,atk:999}};
 expect(f.command("submitConfig",{config:changed,configVersion:0},"nested-config").status).toBe("rejected");
 expect(f.session.configForEditing().buffAmounts?.atk).toBe(initial.buffAmounts?.atk);
 expect(host.files["webconsole_results.json"].last.__fp).toHaveLength(64);
});

it("waits for the native equipment callback and revalidates the live quest scope before starting",()=>{
 const f=fixture();f.tick();host.deferEquipment=true;f.command("startRun",{},"native-start");
 expect(f.session.stage).toBe("Idle");expect(host.nativeWork).toHaveLength(1);
 f.reading.online=true;host.nativeWork.shift()!.run();
 expect(f.session.stage).toBe("Idle");expect(host.files["webconsole_results.json"].last.status).toBe("rejected");
});
it("cancels delayed equipment commands on reset or timeout without blocking title automation",()=>{
 const f=fixture();f.tick();host.deferEquipment=true;f.command("startRun",{},"timed-start");
 host.now+=11;f.tick();expect(host.nativeWork).toHaveLength(0);expect(f.session.stage).toBe("Idle");
 expect(host.files["webconsole_results.json"].last).toMatchObject({id:"timed-start",status:"rejected"});
 f.command("startRun",{},"reset-start");expect(host.nativeWork).toHaveLength(1);
 f.bridge.newScriptSession();expect(host.nativeWork).toHaveLength(0);expect(f.session.stage).toBe("Idle");
});
