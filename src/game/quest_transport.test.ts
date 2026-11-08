import { beforeEach, describe, expect, it, vi } from "vitest";
import { QuestTransport } from "./quest_transport";

const mock = vi.hoisted(() => ({ singleton: vi.fn(), qm: vi.fn(), find: vi.fn(), hook: vi.fn(),
  create: vi.fn(), now: 100 }));
vi.mock("./sdk", () => ({
  clockSeconds: () => mock.now, getSingleton: mock.singleton, questManager: mock.qm,
  findTypeDefinition: mock.find, hookMethod: mock.hook, createInstance: mock.create,
  retain: (object: any, pool: any[]) => { object.add_ref(); pool.push(object); return object; },
  toManagedObject: (value: unknown) => value, toPtr: (value: unknown) => value,
  PRE_HOOK: { CALL_ORIGINAL: 0, SKIP_ORIGINAL: 1 }, relog: { info: vi.fn() },
}));

function fixture() {
  const state = { active: false, playing: false, counter: false, counterType: 0, branch: 0, openSelect: false, execute: 0, questId: 900102,
    hallStatus: 1, questHost: false, postedId: -1, session: true };
  const identifier = { get_field: (name: string) => name === "_QuestNo" ? state.questId : null };
  const member = { get_field: (name: string): any => name === "_hallStatus" ? state.hallStatus
    : name === "_questHost" ? state.questHost : name === "_questIdentifier" ? {
      get_field: (key: string) => key === "_QuestNo" ? state.postedId : key === "_sessionID" ? "native-session" : null,
    } : null };
  const lobby = { call: vi.fn((name: string) => {
    if (name === "isInInternetQuestSession") return state.session;
    if (name === "get_MyLobbyHunterInfo") return member;
    if (name === "createRoom") { state.hallStatus = 2; state.questHost = true; state.postedId = state.questId; }
    return null;
  }) };
  const quest = {} as any;
  const qm = { call: vi.fn((name: string) => {
    if (name === "isActiveQuest") return state.active;
    if (name === "isPlayQuest") return state.playing;
    if (name === "get_ActiveQuestNo") return state.questId;
    return null;
  }), get_field: () => identifier };
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
  const counter = { call: vi.fn((name: string, value?: number) => {
    if (name === "set_QuestCounterType") state.counterType = value!;
    if (name === "get_QuestCounterType") return state.counterType;
    if (name === "get_BaseBranchValue") return state.branch;
    return name === "get_refQuestCounterBehaviorTree" ? { get_address: () => 1234 } : 0;
  }) };
  mock.qm.mockReturnValue(qm);
  mock.singleton.mockImplementation((name: string) => {
    if (name === "snow.gui.GuiManager") return gui;
    if (name === "snow.LobbyManager") return lobby;
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
  return { state, transport: new QuestTransport(() => quest, 45), hooks, scroll, cursor, flow, action, arg, counter, lobby, identifier };
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
    state.active = true; state.questId = 101; state.playing = true;
    transport.tick();
    expect(transport.isActive()).toBe(false);
    expect(transport.getError()).toContain("Another quest");
    expect(flow.call).not.toHaveBeenCalled();
  });

  it("keeps driving the counter past a stopped quest that is still registered", () => {
    // A failed/stopped run leaves isActiveQuest=true with isPlayQuest=false until the
    // counter takes the next quest; that must not be read as "another quest started".
    const { state, transport } = fixture();
    transport.request(900102); transport.tick();
    state.active = true; state.questId = 213754756; state.playing = false;
    transport.tick();
    expect(transport.isActive()).toBe(true);
    expect(transport.getError()).toBeNull();
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

it("uses the hall counter and releases controls without auto-departing before teammates join", () => {
  const { state, transport, hooks, flow, action } = fixture();
  state.questId = 900103;
  state.counter = true; // Reused counter: no awake hook is called by the request.
  transport.request(900103, true);
  const counter = { call: vi.fn() };
  hooks("snow.gui.fsm.questcounter.GuiQuestCounterFsmManager", "awake").pre({ 2: counter });
  expect(counter.call).toHaveBeenCalledWith("set_QuestCounterType", 1);
  transport.tick(); transport.tick();
  expect(state.counterType).toBe(1);
  state.active = true;
  transport.tick();
  expect(transport.isActive()).toBe(true); // Local activation precedes hall publication.
  expect(state.counter).toBe(true);
  state.branch = 1; // Native action reports SUCCESS after its session work.
  transport.tick(); transport.tick(); transport.tick();
  expect(transport.getError()).toBeNull();
  expect(transport.isActive()).toBe(false);
  expect(flow.call).not.toHaveBeenCalled();
  expect(action.release).toHaveBeenCalledOnce();
  expect(hooks("snow.gui.GuiManager", "IsPlayerAllInputDisable").post(99)).toBe(99);
});

it("rejects a reused counter that refuses HallCounter instead of starting a village session", () => {
  const { state, transport, counter, action } = fixture();
  state.counter = true;
  counter.call.mockImplementation(() => 0); // Native setter failed to take effect.
  transport.request(900103, true);
  transport.tick();
  expect(transport.isActive()).toBe(false);
  expect(transport.getError()).toContain("context did not match");
  expect(action.call).not.toHaveBeenCalled();
  expect(transport.getDiagnostics()).toMatchObject({ hall: true, counterType: 0 });
});

it("publishes the native hall identifier before closing, once the session exists", () => {
  const { state, transport, lobby, identifier } = fixture();
  state.questId = 900103;
  transport.request(900103, true); transport.tick(); transport.tick();
  state.active = true; state.branch = 1; state.session = false;
  transport.tick();
  expect(lobby.call).not.toHaveBeenCalledWith("createRoom", identifier);
  expect(state.counter).toBe(true);
  state.session = true;
  transport.tick(); transport.tick();
  expect(lobby.call).toHaveBeenCalledWith("createRoom", identifier);
  expect(state.postedId).toBe(900103);
  expect(state.counter).toBe(false);
});

it("does not recreate an already registered room or silently accept a wrong quest", () => {
  const { state, transport, lobby } = fixture();
  state.questId = 900103; state.hallStatus = 2; state.questHost = true; state.postedId = 10107;
  transport.request(900103, true); transport.tick(); transport.tick();
  state.active = true; state.branch = 1;
  transport.tick();
  expect(lobby.call.mock.calls.some(([name]) => name === "createRoom")).toBe(false);
  expect(transport.getError()).toContain("registration was not confirmed");
});

it("captures the latest configured timeout for each new post",()=>{
 fixture();let timeout=5;const t=new QuestTransport(()=>({})as any,()=>timeout);
 t.request(900102);mock.now=106;t.tick();expect(t.getError()).toContain("timed out");
 timeout=20;t.request(900102);mock.now=112;t.tick();expect(t.getError()).toBeNull();
});
