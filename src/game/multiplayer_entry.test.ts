import { createHash } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
import { MultiplayerEntry, readLobbyIdentity } from "./multiplayer_entry";
import { validateConfig } from "../core/config";
import { defaultConfig, monsterCatalog } from "./default_config";
import type { NativeWebconsole } from "./sdk";

const mock = vi.hoisted(() => ({ host: 0 as number | null, self: 0 as number | null,
  active: false, canPrepare: true, publish: vi.fn(), request: vi.fn(), cancel: vi.fn(),
  running: false, now: 100, corrupt: false }));
vi.mock("./sdk", () => ({
  clockSeconds: () => mock.now, rejson: { load_string: JSON.parse, dump_string: JSON.stringify },
  getSingleton: () => ({ get_field: () => 1, call: (method: string) => {
    const index = method === "getHostIndex" ? mock.host : mock.self;
    return { get_field: (field: string) => field === "_HasValue" ? index !== null : index ?? 0 };
  } }),
  questManager: () => ({ call: (method: string) => method === "isActiveQuest" ? mock.active : false }),
}));
vi.mock("./quest_installer", () => ({ QuestInstaller: class {
  plan: unknown;
  publish(plan: unknown) { mock.publish(plan); this.plan = plan; }
  multiplayerDescriptor() { return JSON.stringify(this.plan) + (mock.corrupt ? "changed" : ""); }
  getQuest() { return {}; }
} }));
vi.mock("./quest_transport", () => ({ QuestTransport: class {
  request = mock.request; cancel = mock.cancel;
  isActive() { return mock.running; }
  getStatus() { return "Idle"; }
  getDiagnostics() { return {}; }
  tick() {}
  getError() { return null; }
} }));
function fixture() {
  const server = { plan: "", owner: "100", members: ["100", "200"], acks: {} as Record<string, string> };
  const port = (self: string): NativeWebconsole => ({
    ping: (s) => s, epoch: () => 1, take_commands: () => [], publish_state: () => {}, publish_results: () => {},
    steam_snapshot: () => ({ available: true, reason: "", lobbies: [{ id: "1000", owner: server.owner, self,
      plan: server.plan, members: server.members.map((id) => ({ id, ack: server.acks[id] ?? "" })) }] }),
    steam_plan: (_lobby, value) => { if (server.owner !== self) return false; server.plan = value; return true; },
    steam_ack: (_lobby, value) => { server.acks[self] = value; return true; },
    steam_digest: (s) => createHash("sha256").update(s).digest("hex"),
  });
  const make = (self: string) => new MultiplayerEntry(validateConfig(defaultConfig), monsterCatalog, () => mock.canPrepare, port(self));
  const host = make("100"), guest = make("200");
  const as = <T>(self: number, action: () => T): T => { mock.self = self; return action(); };
  const tick = (self: number, e: MultiplayerEntry) => as(self, () => { mock.now++; e.tick(); });
  const prepare = () => { as(0, () => host.choose(2)); tick(1, guest); tick(0, host); };
  return { server, host, guest, as, tick, prepare, port };
}
beforeEach(() => {
  vi.clearAllMocks(); mock.host = 0; mock.self = 0; mock.active = false;
  mock.canPrepare = true; mock.running = false; mock.now = 100; mock.corrupt = false;
});
it("does not interpret nullable offline indices as a host", () => {
  mock.host = null; mock.self = null;
  expect(readLobbyIdentity().role).toBe("offline");
  expect(() => fixture().host.choose(0)).toThrow("房主");
  expect(mock.publish).not.toHaveBeenCalled();
});
it("automatically prepares the guest and requires fresh ACKs before hall posting", () => {
  const f = fixture(); f.prepare();
  expect(mock.publish.mock.calls[0]![0]).toMatchObject({ questId: 900103, sequential: false, monsterIds: [98, 54] });
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
