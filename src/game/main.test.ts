import { beforeEach, expect, it, vi } from "vitest";
import { validateConfig } from "../core/config";
import { defaultConfig, monsterCatalog } from "./default_config";
import { RunCore } from "../core/run_core";
import { makeQuestPlan } from "../core/quest_plan";

const h=vi.hoisted(()=>({config:null as any,frames:[] as (()=>void)[],bridges:[] as any[],
  runtimes:[] as any[],entries:[] as any[],gachas:[] as any[],buffs:[] as any[],errors:[] as any[],configError:false,startupPending:false,restoreCalls:0}));
vi.mock("./load_config",()=>({loadConfig:()=>{if(h.configError)throw new Error("corrupt configuration journal");return h.config;}}));
vi.mock("./sdk",()=>({clockSeconds:()=>100,reframework:{
  onFrame:(f:()=>void)=>h.frames.push(f),onDrawUi:()=>{},onScriptReset:()=>{}},
  refFs:{read:()=>"",glob:()=>[]},rejson:{dump_string:JSON.stringify,dump_file:()=>true},relog:{info:()=>{},warn:()=>{},error:(e:any)=>h.errors.push(e)}}));
vi.mock("./equip_wear",()=>({startupRecoveryPending:()=>h.startupPending}));
vi.mock("./recovery_save",()=>({RecoverySave:class {tick(){}}}));
vi.mock("./recovery_commit",()=>({captureRecoveryCommit:()=>null,commitRecovery:()=>{}}));
vi.mock("./entry_host_scope",()=>({entryHostTestScope:()=>false}));
vi.mock("./hud",()=>({drawHud:()=>{}}));
vi.mock("./quest_installer",()=>({QuestInstaller:class {getQuest(){return {};}isInstalled(){return true;}}}));
vi.mock("./gacha",()=>({GachaService:class {
  pools:any;constructor(p:any){this.pools=p;h.gachas.push(this);}configure(p:any){this.pools=p;}hasPool(){return true;}
}}));
vi.mock("./buff_service",()=>({BuffService:class {
  amounts:any;constructor(a:any){this.amounts=a;h.buffs.push(this);}configure(a:any){this.amounts=a;}
  shutdown(){}tick(){}diagnostic(){return {};}
}}));
vi.mock("./native_runtime",()=>({NativeRuntime:class {
  config:any;constructor(c:any,public installer:any,private gacha:any,_test:boolean,private services:any){this.config=c;h.runtimes.push(this);}
  configureRun(c:any){this.config=c;this.gacha.configure(c.gachaPools??{});this.services(c);}
  configNotice:string|null=null;
  rebind(c:any,i:any){this.config=c;this.installer=i;}setPartySizeSource(){}setMultiplayer(){}tick(){}shutdown(){}setConfigRecoveryNotice(m:string|null){this.configNotice=m;}
  now(){return 100;}ready(){return this.configNotice===null;}report(){}policy(){}cancelPost(){}takeDeaths(){return [];}postingError(){return null;}
  read(){return {time:100,quest:null,online:false,canPost:true,enemies:[],deaths:0,players:[{id:0,position:{x:1,y:2,z:3}}]};}
  startupPrepare(){return {ok:true};}startupRestore(){h.restoreCalls++;return {ok:true};}multiplayerValid(){return false;}
}}));
vi.mock("./shop_window",()=>({ShopWindow:class {busy=false;tick(){}draw(){}}}));
vi.mock("./webconsole_bridge",()=>({WebConsoleBridge:class {
  constructor(public session:any){h.bridges.push(this);}tick(){}partyRosterSize(){return null;}newScriptSession(){return {};}
}}));
vi.mock("./multiplayer_entry",()=>({MultiplayerEntry:class {
  constructor(public source:any,_catalog:any,_ready:any,_network:any,public lifecycle:any){h.entries.push(this);}
  runEntry(){return null;}hostTestEntry(){return null;}tick(){}resetForNextRun(){}shutdown(){}
}}));
vi.mock("./multiplayer_run",()=>({MultiplayerRun:class {}}));

beforeEach(async()=>{
  vi.resetModules();h.configError=false;h.startupPending=false;h.restoreCalls=0;h.config=validateConfig(structuredClone(defaultConfig));
  for(const key of ["frames","bridges","runtimes","entries","gachas","buffs","errors"] as const)h[key].length=0;
  await import("./main");expect(h.errors).toEqual([]);expect(h.bridges).toHaveLength(1);
});

it("uses saved rules for entry preparation, services and the replacement session after multiplayer settlement",()=>{
  const first=h.bridges[0].session;
  const edited=validateConfig({...structuredClone(h.config),startPt:321,
    buffAmounts:{atk:23,def:34,crit:45},gachaPools:{only:{entries:[{kind:"armor",id:202375177,w:1}]}},
    runtime:{...h.config.runtime,carveSeconds:9}});
  first.applyConfig(edited);
  const entry=h.entries[0];expect(typeof entry.source).toBe("function");expect(entry.source()).toBe(edited);
  const entryConfig={...edited,quest:{...edited.quest,id:900103}};
  const preview=new RunCore(entryConfig,42);preview.startRun(edited.armorOptions[0]!);
  const plan=makeQuestPlan(entryConfig,monsterCatalog,preview.generateChoices(2)[0]!,1,1,false);
  entry.lifecycle.prepare(plan,{},edited.armorOptions[0]);
  expect(first.stage).toBe("Preparing");expect(first.core.state.wallet.pt).toBe(321);
  expect(first.settings.carveSeconds).toBe(9);expect(h.gachas[0].pools).toEqual(edited.gachaPools);
  expect(h.buffs[0].amounts).toEqual(edited.buffAmounts);expect(h.runtimes[0].config.quest.id).toBe(900103);
  first.stage="Finished";for(const frame of h.frames)frame();
  expect(h.bridges).toHaveLength(2);const next=h.bridges[1].session;
  expect(next.core.config.quest.id).toBe(900102);expect(next.configForEditing().startPt).toBe(321);
  expect(next.configForEditing().gachaPools).toEqual(edited.gachaPools);
  expect(next.settings.carveSeconds).toBe(9);expect(entry.source().quest.id).toBe(900102);
  expect(next.core.config.startPt).not.toBe(defaultConfig.startPt);
});

it("keeps the selected solo route when the app creates the next session",()=>{
  const first=h.bridges[0].session;first.setRunRoute("reentry");
  expect(h.entries[0].source().runtime.route).toBe("reentry");
  // A completed multiplayer session restores the canonical base quest configuration.
  first.core.replaceConfig({...first.core.config,quest:{...first.core.config.quest,id:900103}});
  first.stage="Finished";first.setRunRoute("reentry");
  expect(h.entries[0].source().quest.id).toBe(900102);
  for(const frame of h.frames)frame();
  expect(h.bridges[1].session.nextRoute).toBe("reentry");
});
it("boots a recovery-only coordinator after a corrupt planner journal, without permitting a new run",async()=>{
 vi.resetModules();h.configError=true;h.startupPending=true;const count=h.bridges.length;await import("./main");
 expect(h.errors).toEqual([]);expect(h.bridges).toHaveLength(count+1);
 const runtime=h.runtimes.at(-1),session=h.bridges.at(-1).session;
 expect(runtime.configNotice).toContain("配置恢复待办");expect(runtime.ready()).toBe(false);
 expect(session.start(session.core.config.armorOptions[0]).ok).toBe(false);
 // Recovery callbacks are still registered; bootstrap has not exited early.
 expect(h.frames.length).toBeGreaterThan(0);
 session.tick();expect(h.restoreCalls).toBeGreaterThan(0);
});
