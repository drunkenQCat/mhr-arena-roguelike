import { beforeEach, expect, it, vi } from "vitest";
import { MultiplayerEntry, readLobbyIdentity } from "./multiplayer_entry";
import { validateConfig } from "../core/config";
import { defaultConfig, monsterCatalog } from "./default_config";

const mock = vi.hoisted(() => ({ host: null as number | null, self: null as number | null,
  active: false, canPrepare: true, publish: vi.fn(), request: vi.fn(), cancel: vi.fn(), running: false }));
vi.mock("./sdk", () => ({
  getSingleton: () => ({ get_field: () => 1, call: (method: string) => {
    const index = method === "getHostIndex" ? mock.host : mock.self;
    return { get_field: (field: string) => field === "_HasValue" ? index !== null : index ?? 0 };
  } }),
  questManager: () => ({ call: (method: string) => method === "isActiveQuest" ? mock.active : false }),
}));
vi.mock("./quest_installer", () => ({ QuestInstaller: class {
  publish = mock.publish;
  getQuest() { return {}; }
} }));
vi.mock("./quest_transport", () => ({ QuestTransport: class {
  request = mock.request; cancel = mock.cancel;
  isActive() { return mock.running; }
  getStatus() { return "Idle"; }
  tick() {}
  getError() { return null; }
} }));
function entry() { return new MultiplayerEntry(validateConfig(defaultConfig), monsterCatalog, () => mock.canPrepare); }
beforeEach(() => { vi.clearAllMocks(); mock.host = null; mock.self = null; mock.active = false; mock.canPrepare = true; mock.running = false; });

it("does not interpret nullable offline indices as a host", () => {
  expect(readLobbyIdentity().role).toBe("offline");
  expect(() => entry().choose(0)).toThrow("房主");
  expect(mock.publish).not.toHaveBeenCalled();
});
it("restricts native hall posting to the lobby host and keeps solo quest separate", () => {
  mock.host = 0; mock.self = 0;
  const e = entry(); e.choose(2); e.post();
  const plan = mock.publish.mock.calls[0]![0];
  expect(plan).toMatchObject({ questId: 900103, baseId: 603, sequential: false, monsterIds: [98, 54] });
  expect(mock.request).toHaveBeenCalledWith(900103, true);
  expect(e.snapshot().code).toBe("MHR-ENTRY-1-D");
});
it("allows guests only to import supported host codes, never select or post", () => {
  mock.host = 0; mock.self = 1;
  const e = entry();
  expect(() => e.choose(0)).toThrow("房主");
  expect(() => e.importCode("arbitrary-monsters")).toThrow("不受此版本支持");
  e.importCode("MHR-ENTRY-1-Q");
  expect(mock.publish.mock.calls[0]![0].sequential).toBe(true);
  expect(() => e.post()).toThrow("房主");
  expect(mock.request).not.toHaveBeenCalled();
});
it("cannot overwrite an accepted quest or enter before solo restoration", () => {
  mock.host = 0; mock.self = 0;
  const e = entry(); mock.active = true;
  expect(() => e.choose(0)).toThrow("承接任务");
  mock.active = false; mock.canPrepare = false;
  expect(() => e.choose(0)).toThrow("恢复");
  expect(mock.publish).not.toHaveBeenCalled();
});
it("invalidates host posting when the lobby owner changes", () => {
  mock.host = 0; mock.self = 0;
  const e = entry(); e.choose(0); e.post();
  mock.host = 1;
  expect(() => e.post()).toThrow("房主");
  mock.running = true; e.tick();
  expect(mock.cancel).toHaveBeenCalled();
});
