import { createHash } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
import { MultiplayerEntry, readLobbyIdentity } from "./multiplayer_entry";
import { validateConfig } from "../core/config";
import { defaultConfig, monsterCatalog } from "./default_config";
import type { NativeWebconsole } from "./sdk";

const mock = vi.hoisted(() => ({ host: 0 as number | null, self: 0 as number | null,
  active: false, canPrepare: true, publish: vi.fn(), request: vi.fn(), cancel: vi.fn(),
  running: false, playing: false, quest: -1, now: 100, corrupt: false }));
vi.mock("./sdk", () => ({
  clockSeconds: () => mock.now, rejson: { load_string: JSON.parse, dump_string: JSON.stringify },
  getSingleton: () => ({ get_field: () => 1, call: (method: string) => {
    const index = method === "getHostIndex" ? mock.host : mock.self;
    return { get_field: (field: string) => field === "_HasValue" ? index !== null : index ?? 0 };
  } }),
  questManager: () => ({ call: (method: string) => method === "isActiveQuest" ? mock.active : method === "isPlayQuest" ? mock.playing : mock.quest }),
}));
vi.mock("./quest_installer", () => ({ QuestInstaller: class {
  plan: unknown;
  publish(plan: unknown) { mock.publish(plan); this.plan = plan; }
  multiplayerDescriptor() { return JSON.stringify(this.plan) + (mock.corrupt ? "changed" : ""); }
  getQuest() { return {}; }
  getPlan() { return this.plan; }
} }));
vi.mock("./quest_transport", () => ({ QuestTransport: class {
  request = mock.request; cancel = mock.cancel;
  isActive() { return mock.running; }
  getStatus() { return "Idle"; }
  getDiagnostics() { return {}; }
  tick() {}
  getError() { return null; }
} }));
function fixture(lifecycle?: import("./multiplayer_entry").EntryLifecycle) {
  const server = { plan: "", owner: "100", members: ["100", "200"], acks: {} as Record<string, string> };
  const port = (self: string): NativeWebconsole => ({
    ping: (s) => s, epoch: () => 1, take_commands: () => [], publish_state: () => {}, publish_results: () => {},
    steam_snapshot: () => ({ available: true, reason: "", lobbies: [{ id: "1000", owner: server.owner, self,
      plan: server.plan, members: server.members.map((id) => ({ id, ack: server.acks[id] ?? "" })) }] }),
    steam_plan: (_lobby, value) => { if (server.owner !== self) return false; server.plan = value; return true; },
    steam_ack: (_lobby, value) => { server.acks[self] = value; return true; },
    steam_digest: (s) => createHash("sha256").update(s).digest("hex"),
  });
  const make = (self: string) => new MultiplayerEntry(validateConfig(defaultConfig), monsterCatalog, () => mock.canPrepare, port(self), lifecycle);
  const host = make("100"), guest = make("200");
  const as = <T>(self: number, action: () => T): T => { mock.self = self; return action(); };
  const tick = (self: number, e: MultiplayerEntry) => as(self, () => { mock.now++; e.tick(); });
  const prepare = () => { as(0, () => host.choose(2)); tick(1, guest); tick(0, host); };
  return { server, host, guest, as, tick, prepare, port };
}
beforeEach(() => {
  vi.clearAllMocks(); mock.host = 0; mock.self = 0; mock.active = false;
  mock.canPrepare = true; mock.running = false; mock.playing = false; mock.quest = -1; mock.now = 100; mock.corrupt = false;
});
it("does not interpret nullable offline indices as a host", () => {
  mock.host = null; mock.self = null;
  expect(readLobbyIdentity().role).toBe("offline");
  expect(() => fixture().host.choose(0)).toThrow("房主");
  expect(mock.publish).not.toHaveBeenCalled();
});
it('exposes only the locally prepared fixed entry identity before questStart',()=>{
 const lifecycle={prepare:vi.fn(),prepared:()=>true,cancel:vi.fn()};const f=fixture(lifecycle);
 expect(f.host.preparedEntry()).toBeNull();f.prepare();
 expect(f.as(0,()=>f.host.preparedEntry())).toMatchObject({lobby:'1000',owner:'100',self:'100',members:['100','200'],plan:{questId:900103}});
 expect(f.as(1,()=>f.guest.preparedEntry())).toMatchObject({self:'200'});expect(mock.playing).toBe(false);
 mock.active=true;mock.quest=101;expect(f.as(0,()=>f.host.preparedEntry())).toBeNull();
 mock.active=false;f.server.members.push('300');f.tick(0,f.host);expect(f.as(0,()=>f.host.preparedEntry())).toBeNull();
});
it("automatically prepares the guest and requires fresh ACKs before hall posting", () => {
  const f = fixture(); f.prepare();
  expect(mock.publish.mock.calls[0]![0]).toMatchObject({ questId: 900103, sequential: false });
  expect(mock.publish.mock.calls[0]![0].wave.rewardPt).toBeGreaterThan(0);
  expect(mock.publish.mock.calls[0]![0].wave.hpMul).toBeGreaterThan(0);
  expect(f.host.snapshot().canPost).toBe(true);
  const oldAck = f.server.acks["200"];
  f.as(0, () => f.host.post());
  expect(f.server.acks["100"]).not.toBe(oldAck);
  f.tick(0, f.host);
  expect(mock.request).not.toHaveBeenCalled();
  f.tick(1, f.guest); f.tick(0, f.host);
  expect(mock.request).toHaveBeenCalledWith(900103, true);
  expect(mock.request).toHaveBeenCalledOnce();
  f.tick(0, f.host);
  expect(mock.request).toHaveBeenCalledOnce();
});
it("never counts a one-player Steam lobby as multiplayer readiness", () => {
  const f = fixture(); f.server.members = ["100"];
  f.as(0, () => f.host.choose(0)); f.tick(0, f.host);
  expect(() => f.host.post()).toThrow("两名真实");
});
it("blocks posting when a new member has not installed or confirmed the plan", () => {
  const f = fixture(); f.prepare(); f.server.members.push("300");
  expect(() => f.as(0, () => f.host.post())).toThrow("全部确认");
  expect(mock.request).not.toHaveBeenCalled();
});
it("does not accept a different native table digest", () => {
  const f = fixture(); f.as(0, () => f.host.choose(0)); mock.corrupt = true;
  f.tick(1, f.guest); mock.corrupt = false; f.tick(0, f.host);
  expect(f.server.acks["200"]).toBe("error");
  expect(f.guest.snapshot().message).toContain("哈希不一致");
  expect(() => f.as(0, () => f.host.post())).toThrow("全部确认");
});
it("times out a posting barrier instead of reusing a stale prepare ACK", () => {
  const f = fixture(); f.prepare(); f.as(0, () => f.host.post());
  mock.now += 21; f.tick(0, f.host);
  expect(mock.request).not.toHaveBeenCalled();
  expect(f.host.snapshot().message).toContain("超时");
});
it("rotates revisions when the host changes the selected wave", () => {
  const f = fixture(); f.prepare(); const old = f.server.acks["200"];
  f.as(0, () => f.host.choose(1)); f.tick(0, f.host);
  expect(f.host.snapshot().canPost).toBe(false);
  f.tick(1, f.guest); expect(f.server.acks["200"]).not.toBe(old);
});
it("allows guests no choice or post commands", () => {
  const f = fixture();
  expect(() => f.as(1, () => f.guest.choose(0))).toThrow("房主");
  expect(() => f.as(1, () => f.guest.post())).toThrow("全部确认");
});
it("does not overwrite accepted quests or incomplete solo restoration", () => {
  const f = fixture(); mock.active = true;
  expect(() => f.host.choose(0)).toThrow("承接任务");
  mock.active = false; mock.canPrepare = false;
  expect(() => f.host.choose(0)).toThrow("恢复");
});
it("ignores forged-owner or unsupported plan envelopes", () => {
  const f = fixture(); f.as(0, () => f.host.choose(0));
  const plan = JSON.parse(f.server.plan); plan.owner = "forged"; f.server.plan = JSON.stringify(plan);
  mock.publish.mockClear(); f.tick(1, f.guest);
  expect(mock.publish).not.toHaveBeenCalled();
  plan.owner = "100"; plan.schema = 99; f.server.plan = JSON.stringify(plan);
  f.tick(1, f.guest); expect(mock.publish).not.toHaveBeenCalled();
});
it("invalidates a pending post on host migration", () => {
  const f = fixture(); f.prepare(); f.as(0, () => f.host.post());
  f.server.owner = "200"; mock.host = 1; f.tick(0, f.host);
  expect(mock.request).not.toHaveBeenCalled();
  expect(f.host.snapshot().posting).toBe(false);
});
it("cannot replace a quest accepted after preparing the table", () => {
  const f = fixture(); f.prepare(); mock.active = true;
  expect(() => f.as(0, () => f.host.post())).toThrow("承接任务");
  expect(mock.request).not.toHaveBeenCalled();
});
it("requires the updated DLL rather than silently falling back to manual codes", () => {
  const f = fixture(), p = f.port("100"); delete p.steam_snapshot;
  const e = new MultiplayerEntry(validateConfig(defaultConfig), monsterCatalog, () => true, p);
  expect(() => e.choose(0)).toThrow("0.4.0");
});

it("checks the complete business configuration before guest table mutation",()=>{
 const f=fixture();f.as(0,()=>f.host.choose(0));const packet=JSON.parse(f.server.plan);
 packet.rules="a".repeat(64);f.server.plan=JSON.stringify(packet);mock.publish.mockClear();f.tick(1,f.guest);
 expect(mock.publish).not.toHaveBeenCalled();expect(f.server.acks["200"]).toBe("error");
});

it("keeps entry transport alive until posting finishes and the native quest is actually playing", () => {
  const f = fixture(); f.prepare(); f.as(0, () => f.host.post());
  f.tick(1, f.guest); f.tick(0, f.host);
  mock.active = true; mock.quest = 900103; mock.running = true;
  expect(f.as(0, () => f.host.runEntry())).toBeNull();
  mock.running = false;
  expect(f.as(0, () => f.host.runEntry())).toBeNull();
  expect(f.as(1, () => f.guest.runEntry())).toBeNull();
  mock.playing = true; mock.running = true;
  expect(f.as(0, () => f.host.runEntry())).toBeNull();
  mock.running = false;
  expect(f.as(0, () => f.host.runEntry())).toMatchObject({owner: "100", self: "100"});
  expect(f.as(1, () => f.guest.runEntry())).toMatchObject({owner: "100", self: "200"});
});

it("keeps the acknowledged roster when a late member joins between posting and departure", () => {
  const f=fixture(); f.prepare(); f.as(0,()=>f.host.post());
  f.tick(1,f.guest); f.tick(0,f.host);
  mock.active=true; mock.playing=true; mock.quest=900103;
  f.server.members.push("300"); f.tick(0,f.host); f.tick(1,f.guest);
  const entry=f.as(0,()=>f.host.runEntry());
  expect(entry?.members).toEqual(["100","200"]);
  expect(f.as(1,()=>f.guest.runEntry())?.members).toEqual(["100","200"]);
  entry!.members.push("changed-by-caller");
  expect(f.as(0,()=>f.host.runEntry())?.members).toEqual(["100","200"]);
  // MultiplayerRun compares this accepted roster to the actual lobby and stops
  // on the late join; it must not adopt the unprepared player as a third member.
  expect(f.host.snapshot().canPost).toBe(false);
});

it("advertises posting only while both native and business state allow it",()=>{
  const f=fixture(); f.prepare(); expect(f.host.snapshot().canPost).toBe(true);
  mock.active=true; expect(f.host.snapshot().canPost).toBe(false);
  mock.active=false; mock.canPrepare=false; expect(f.host.snapshot().canPost).toBe(false);
});


it("cancels preparation on both peers, rejects the retired plan, then prepares a fresh session", () => {
  const life = {prepare:vi.fn(),prepared:()=>true,cancel:vi.fn()}; const f=fixture(life);
  f.prepare(); const old=JSON.parse(f.server.plan);
  f.as(0,()=>f.host.cancel()); f.tick(1,f.guest);
  expect(life.cancel).toHaveBeenCalled(); expect(f.guest.snapshot().sync).toMatchObject({applied:false});
  f.server.plan=JSON.stringify(old); const before=life.prepare.mock.calls.length; f.tick(1,f.guest);
  expect(life.prepare).toHaveBeenCalledTimes(before);
  f.as(0,()=>f.host.choose(0)); f.tick(1,f.guest); f.tick(0,f.host);
  expect(JSON.parse(f.server.plan).session).not.toBe(old.session); expect(f.host.snapshot().canPost).toBe(true);
});

it("never acknowledges a guest whose personal startup kit failed", () => {
 const f=fixture({prepare:()=>{if(mock.self===1)throw new Error("pouch backup failed");},prepared:()=>false,cancel:vi.fn()});
 f.as(0,()=>f.host.choose(0)); f.tick(1,f.guest); f.tick(0,f.host);
 expect(f.server.acks["200"]).toBe("error"); expect(f.host.snapshot().canPost).toBe(false);
});


it("posts the displayed choice and preserves the shared pair when comparing sequential with simultaneous", () => {
 const f=fixture();f.tick(0,f.host);
 const options=f.host.snapshot().options as {index:number;monsters:string[]}[];
 f.as(0,()=>f.host.choose(1));expect((mock.publish.mock.calls.at(-1)![0] as any).wave.monsters).toEqual(options[1]!.monsters);
 const seed=JSON.parse(f.server.plan).seed;
 f.as(0,()=>f.host.choose(2));expect(JSON.parse(f.server.plan).seed).toBe(seed);
 expect((mock.publish.mock.calls.at(-1)![0] as any).wave.monsters).toEqual(options[2]!.monsters);
});

it("uses current saved rules for previews and ACKs after resetting the entry, without replacing native hooks",()=>{
 const f=fixture();let cfg=validateConfig(structuredClone(defaultConfig));
 const host=new MultiplayerEntry(()=>cfg,monsterCatalog,()=>true,f.port("100"));
 const guest=new MultiplayerEntry(()=>cfg,monsterCatalog,()=>true,f.port("200"));
 f.as(0,()=>host.choose(0));f.tick(1,guest);f.tick(0,host);
 f.as(0,()=>host.resetForNextRun());f.as(1,()=>guest.resetForNextRun());
 cfg=validateConfig({...structuredClone(cfg),startPt:321,armorOptions:[cfg.armorOptions[1]!],
   reward:{...cfg.reward,weakBase:133},buffAmounts:{atk:23,def:34,crit:45}});
 f.as(0,()=>host.choose(0));f.tick(1,guest);f.tick(0,host);
 expect(host.snapshot().armor).toBe(cfg.armorOptions[0]);expect(host.snapshot().canPost).toBe(true);
 const preview=host.snapshot().options as {rewardPt:number}[];expect(preview[0]!.rewardPt).toBe(133);
 const plans=mock.publish.mock.calls.map(c=>c[0]);expect(plans.at(-1).wave.rewardPt).toBe(133);
});
