import { beforeEach, describe, expect, it, vi } from "vitest";
import { QuestTransport } from "./quest_transport";

const mock = vi.hoisted(() => ({ singleton: vi.fn(), qm: vi.fn(), find: vi.fn(), hook: vi.fn(),
  create: vi.fn(), now: 100 }));
vi.mock("./sdk", () => ({
  clockSeconds: () => mock.now, getSingleton: mock.singleton, questManager: mock.qm,
  findTypeDefinition: mock.find, hookMethod: mock.hook, createInstance: mock.create,
  retain: (object: any, pool: any[]) => { object.add_ref(); pool.push(object); return object; },
  toManagedObject: (value: unknown) => value, toPtr: (value: unknown) => value,
  PRE_HOOK: { CALL_ORIGINAL: 0, SKIP_ORIGINAL: 1 },
}));

function fixture() {
  const state = { active: false, playing: false, counter: false, openSelect: false, execute: 0, questId: 900102 };
  const quest = {} as any;
  const qm = { call: vi.fn((name: string) => {
    if (name === "isActiveQuest") return state.active;
    if (name === "isPlayQuest") return state.playing;
    if (name === "get_ActiveQuestNo") return state.questId;
    return null;
  }) };
  const cursor = { call: vi.fn() };
  const scroll = { get_field: () => cursor, set_field: vi.fn() };
  const select = { get_field: () => scroll };
  const flow = { call: vi.fn((name: string) => { if (name === "requestGoQuest") state.playing = true; }) };
  const gui = { call: vi.fn((name: string) => {
    if (name === "IsCanInvokeQuestBoard") return true;
    if (name === "isOpenSelectInfo") return state.openSelect;
    if (name === "get_refGuiCommonSelectWindow") return select;
    if (name === "get_refQuestStartFlowHandler") return flow;
    return null;
  }) };
  const facility = { call: vi.fn((name: string) => { state.counter = name === "activateOnly"; }) };
  const counter = { call: vi.fn((name: string) => name === "get_refQuestCounterBehaviorTree"
    ? { get_address: () => 1234 } : 0) };
  mock.qm.mockReturnValue(qm);
  mock.singleton.mockImplementation((name: string) => {
    if (name === "snow.gui.GuiManager") return gui;
    if (name === "snow.LobbyFacilityUIManager") return facility;
    if (name.endsWith("GuiQuestCounterFsmManager")) return state.counter ? counter : null;
    return null;
  });
  const routine = { call: vi.fn((name: string) => {
    if (name === "isExecute") return true;
    if (name === "execute") { state.execute++; state.openSelect = true; }
  }) };
  const action = { add_ref: vi.fn(), release: vi.fn(), call: vi.fn(), get_field: () => routine };
  const arg = { add_ref: vi.fn(), release: vi.fn(), call: vi.fn() };
  mock.create.mockImplementation((type: string) => type.endsWith("ActionArg") ? arg : action);
  const hooks = (type: string, name: string) => {
    const entry = mock.hook.mock.calls.find((args) => args[0].key === `${type}.${name}`)!;
    return { pre: entry[1] as (...args: any[]) => any, post: entry[2] as (...args: any[]) => any };
  };
  return { state, transport: new QuestTransport(() => quest, 45), hooks, scroll, cursor, flow, action, arg };
}

beforeEach(() => {
  vi.clearAllMocks(); mock.now = 100;
  mock.find.mockImplementation((type: string) => ({ get_method: (name: string) => ({ key: `${type}.${name}` }) }));
});
describe("bounded native quest transport", () => {
  it("ticks the native routine, selects solo, confirms the correct return enum and departs", () => {
    const { state, transport, hooks, scroll, cursor, flow, action } = fixture();
    transport.request(900102);
    transport.tick(); transport.tick(); transport.tick();
    expect(state.execute).toBeGreaterThan(0);
    expect(action.call).toHaveBeenCalledWith(".ctor");
    expect(cursor.call).toHaveBeenCalledWith("set_index", 0);
    expect(scroll.set_field).toHaveBeenCalledWith("_result", 1);
    expect(hooks("snow.gui.GuiManager", "updateYNInfoWindow(System.UInt32)").post(99)).toBe(0);
    state.active = true;
    transport.tick(); transport.tick(); transport.tick(); transport.tick();
    expect(flow.call).toHaveBeenCalledWith("requestGoQuest", true);
    expect(transport.isActive()).toBe(false);
    expect(action.release).toHaveBeenCalledOnce();
    expect(hooks("snow.gui.GuiManager", "updateYNInfoWindow(System.UInt32)").post(99)).toBe(99);
    expect(hooks("snow.gui.GuiManager", "IsPlayerAllInputDisable").post(99)).toBe(99);
  });

  it("waits through disappearing village managers after departure", () => {
    const { state, transport } = fixture();
    transport.request(900102); transport.tick(); transport.tick();
    state.active = true;
    transport.tick(); transport.tick(); transport.tick();
    state.playing = false;
    mock.singleton.mockReturnValue(null);
    transport.tick();
    expect(transport.getError()).toBeNull();
    expect(transport.isActive()).toBe(true);
    state.playing = true;
    transport.tick();
    expect(transport.isActive()).toBe(false);
    expect(transport.getError()).toBeNull();
  });

  it("releases all input/confirmation overrides when its deadline expires", () => {
    const { transport, hooks } = fixture();
    transport.request(900102); transport.tick(); transport.tick();
    mock.now += 46;
    transport.tick();
    expect(transport.isActive()).toBe(false);
    expect(transport.getError()).toContain("timed out");
    expect(hooks("snow.gui.GuiManager", "IsPlayerAllInputDisable").post(99)).toBe(99);
    expect(hooks("snow.gui.GuiManager", "updateYNInfoWindow(System.UInt32)").post(99)).toBe(99);
  });

  it("stops when a different quest is accepted instead of auto-departing", () => {
    const { state, transport, flow } = fixture();
    transport.request(900102); transport.tick();
    state.active = true; state.questId = 101;
    transport.tick();
    expect(transport.isActive()).toBe(false);
    expect(transport.getError()).toContain("Another quest");
    expect(flow.call).not.toHaveBeenCalled();
  });

  it("distinguishes routine isExecute errors and cleans up on failure", () => {
    const { transport, action } = fixture();
    const original = action.get_field;
    action.get_field = () => ({ call: () => { throw Error("engine failure"); } }) as any;
    transport.request(900102); transport.tick(); transport.tick();
    expect(transport.getError()).toContain("routine.isExecute");
    expect(transport.isActive()).toBe(false);
    action.get_field = original;
  });
});
