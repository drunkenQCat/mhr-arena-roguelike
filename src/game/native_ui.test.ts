import { beforeEach, expect, it, vi } from "vitest";
const host = vi.hoisted(() => ({ objects: {} as Record<string, any>, hooks: new Map<string, any>(), installations: 0,
  now: 100, storage: {} as Record<string, unknown> }));
vi.mock("./sdk", () => ({
  clockSeconds: () => host.now, getSingleton: (n: string) => host.objects[n] ?? null,
  findTypeDefinition: (type: string) => ({ get_method: (name: string) => ({ key: `${type}.${name}` }) }),
  hookMethod: (method: any, pre: any, post: any) => { host.installations++; host.hooks.set(method.key, { pre, post }); },
  PRE_HOOK: { CALL_ORIGINAL: 0 }, toPtr: (v: unknown) => v, toManagedObject: (v: unknown) => v,
  reframework: { getThreadId: () => 1, getHookStorage: () => host.storage },
}));
import { NativeUi } from "./native_ui";
const TITLE = "snow.gui.fsm.title.GuiTitleFsmManager";
const MENU = "snow.gui.fsm.title.GuiTitleMenuFsmManager";
function obj(address: string, values: Record<string, any> = {}, methods: Record<string, any> = {}): any {
  return { get_address: () => address, get_field: (n: string) => values[n] ?? null,
    set_field: (n: string, v: unknown) => { values[n] = v; },
    call: (n: string, ...args: unknown[]) => typeof methods[n] === "function" ? methods[n](...args) : methods[n] ?? null };
}
function fixture() {
  const state = { node: "Title_TopMenu_Demo", menu: 2, saveOpen: false, village: false, network: false,
    error: "发生连接错误\n[MR-111-83]", info: false, mode: 2 };
  const mouse = obj("mouse"), cursor = obj("cursor", { "<index>k__BackingField": 1, "<mouseCtrl>k__BackingField": mouse });
  const slot = obj("existing", { _HunterName: "hunter", _HunterRank: 1, _MasterRank: 1 });
  const empty = obj("empty", { _HunterName: "(仮)名無し", _HunterRank: -1, _MasterRank: -1 });
  const data = { get_size: () => 3, get_element: (i: number) => i === 0 ? slot : empty };
  host.objects["snow.SnowSaveService"] = obj("save-service", { _LoadInfoData: obj("load-info", { _HunterArray: data }) });
  const save = obj("save", { _SlotDataArray: data, _CurrentSlotNo: 0 }, { isOpen: () => state.saveOpen });
  const network = obj("network", {}, { isOpen: () => state.network, getText: () => state.error, get_WindowType: 1 });
  const info = obj("info", {}, { isOpen: () => state.info, getText: "正在加载", get_WindowType: () => state.mode });
  host.objects["snow.gui.GuiManager"] = obj("gui", {}, { get_refGuiSaveDataSelectMenu: save,
    get_refGuiNetworkErrorWindow: network, get_refGuiCommonInfoWindow: info, IsCanInvokeQuestBoard: () => state.village });
  host.objects["snow.QuestManager"] = obj("quest", {}, { isActiveQuest: false });
  host.objects[TITLE] = obj("title", {}, { getCurrentNodeName: () => state.node });
  host.objects[MENU] = obj("menu", {}, { get_TitleMenuState: () => state.menu, isOpenTitle: true, get_TitleMenuCursor: cursor });
  return { ui: new NativeUi("epoch-1", () => 900103), state, save, mouse };
}
function signal(name: string, argument?: unknown) {
  const hook = host.hooks.get(`snow.gui.StmGuiInput.${name}`);
  hook.pre([undefined, undefined, argument]);
  return hook.post(0);
}
beforeEach(() => { host.objects = {}; host.hooks.clear(); host.installations = 0; host.now = 100; host.storage = {}; });

it("rotates UI identity without accumulating hooks or replaying old input across runs", () => {
 const f=fixture();const previous=f.ui.observe();
 f.ui.request({id:"old",cmd:"title.continue",sceneToken:previous.sceneToken});
 const count=host.installations;expect(count).toBeGreaterThan(0);
 f.ui.rebind("epoch-2",()=>900102);
 expect(signal("getDecideButtonTrg")).toBe(0);expect(f.ui.poll()).toBeNull();
 expect(()=>f.ui.request({id:"stale",cmd:"title.continue",sceneToken:previous.sceneToken})).toThrow();
 for(let i=0;i<5;i++) {
  f.ui.rebind(`epoch-${i+3}`,()=>900103);
  f.ui.request({id:`new-${i}`,cmd:"title.continue",sceneToken:f.ui.observe().sceneToken});
 }
 expect(host.installations).toBe(count);
});

it("disarms pending input when a bridge is retired between runs", () => {
  const f = fixture(); const v = f.ui.observe();
  f.ui.request({id:"old",cmd:"title.continue",sceneToken:v.sceneToken});
  f.ui.shutdown();
  expect(signal("getDecideButtonTrg")).toBe(0);
  expect(f.ui.poll()).toBeNull();
});

it("leaves absent UI unknown and never claims that missing players imply loading", () => {
  const view = new NativeUi("bridge", () => 900103).observe();
  expect(view.scene).toBe("unknown"); expect(view.loading).toBeNull(); expect(view.allowedActions).toEqual([]);
});
it("does not treat preview players or default names in empty slots as a loaded save", () => {
  const f = fixture(); f.state.node = "ロード画面初期化"; f.state.saveOpen = true;
  const view = f.ui.observe(); expect(view.scene).toBe("save_select");
  expect(view.slots.map(s => s.occupied)).toEqual([true, false, false]);
  expect(() => f.ui.request({ id: "bad", cmd: "save.load", slot: 2, sceneToken: view.sceneToken })).toThrow("existing");
  expect(f.save.get_field("_CurrentSlotNo")).toBe(0);
});

it("uses canonical native slots instead of the reordered GUI preview to name and validate a character", () => {
 const f=fixture();f.state.node="ロード画面初期化";f.state.saveOpen=true;
 const other=obj("other",{_HunterName:"other hunter",_HunterRank:2,_MasterRank:1});
 f.save.set_field("_SlotDataArray",{get_size:()=>3,get_element:()=>other});
 expect(f.ui.observe().slots.map(s=>s.name)).toEqual(["hunter","(仮)名無し","(仮)名無し"]);
 expect(()=>f.ui.request({id:"wrong",cmd:"save.load",slot:2,sceneToken:f.ui.observe().sceneToken})).toThrow("existing");
});
it("refuses to operate the reused save UI during new-game or overwrite flows", () => {
  const f = fixture(); f.state.node = "NewGame"; f.state.saveOpen = true;
  expect(f.ui.observe().scene).toBe("save_menu_unknown"); expect(f.ui.observe().allowedActions).toEqual([]);
});
it("distinguishes passive load progress from an actionable dialog", () => {
  const f = fixture(); f.state.node = "ロード画面初期化"; f.state.saveOpen = true; f.state.info = true;
  const view = f.ui.observe(); expect(view.scene).toBe("loading"); expect(view.loading).toBe(true);
  expect(view.dialogs[0]?.passive).toBe(true); expect(view.allowedActions).toEqual([]);
});
it("waits for system-save loading before the save menu has opened", () => {
  const f = fixture(); f.state.node = "LoadSystemSaveData"; f.state.info = true;
  expect(f.ui.observe().scene).toBe("loading"); expect(f.ui.observe().dialogs[0]?.passive).toBe(true);
});
it("uses actual village readiness even while the save-preview object is being retired", () => {
  const f = fixture(); f.state.saveOpen = true; f.state.village = true;
  expect(f.ui.observe().scene).toBe("village"); expect(f.ui.observe().slots).toEqual([]);
});
it("only accepts a supported network error and rejects a stale dialog token", () => {
  const f = fixture(); f.state.network = true;
  const old = f.ui.observe(); f.state.network = false; f.ui.observe(); f.state.network = true;
  const next = f.ui.observe();
  expect(() => f.ui.request({ id: "stale", cmd: "dialog.close", sceneToken: next.sceneToken,
    dialogToken: old.dialogs[0]?.token })).toThrow("Dialog changed");
  f.state.error = "unrecognised error";
  expect(f.ui.observe().allowedActions).toEqual([]);
});
it("emulates a native trigger for the frame, not just the first condition read", () => {
  const f = fixture(); const view = f.ui.observe();
  f.ui.request({ id: "continue", cmd: "title.continue", sceneToken: view.sceneToken });
  expect(signal("getDecideMouseEventTrg", obj("other-control"))).toBe(0);
  expect(signal("getDecideMouseEventTrg", f.mouse)).toBe(1);
  expect(signal("getDecideMouseEventTrg", f.mouse)).toBe(1);
  expect(f.ui.poll()).toBeNull(); // No transition => no false applied receipt.
  expect(signal("getDecideMouseEventTrg", f.mouse)).toBe(0);
  host.now = 110;
  expect(f.ui.poll()?.status).toBe("uncertain");
});
it("requires a real transition, and disarms input as soon as the UI changes", () => {
  const f = fixture(); const view = f.ui.observe();
  f.ui.request({ id: "continue", cmd: "title.continue", sceneToken: view.sceneToken });
  signal("getDecideMouseEventTrg", f.mouse);
  f.state.node = "ロード画面初期化"; f.state.saveOpen = true;
  expect(signal("getDecideButtonTrg")).toBe(0);
  const receipt = f.ui.poll(); expect(receipt?.status).toBe("applied"); expect(receipt?.id).toBe("continue");
});
it("does not inject save confirmation outside the native load routine", () => {
  const f = fixture(); f.state.node = "ロード画面初期化"; f.state.saveOpen = true;
  f.ui.request({ id: "load", cmd: "save.load", slot: 1, sceneToken: f.ui.observe().sceneToken });
  expect(signal("getDecideButtonTrg")).toBe(0);
  const scope = host.hooks.get("snow.gui.GuiSaveDataSelectMenu.routineLoadDataSelect");
  scope.pre([]); expect(signal("getDecideButtonTrg")).toBe(1); scope.post(0);
  f.state.info = true;
  expect(f.ui.poll()?.status).toBe("applied");
});

function resultFixture() {
  const f = fixture();
  const r = { node:"Reward", active:true, playing:false, quest:900103, unique:7, receive:0, village:false };
  host.objects["snow.QuestManager"] = obj("quest", {}, {isActiveQuest:()=>r.active, isPlayQuest:()=>r.playing,
    get_ActiveQuestNo:()=>r.quest, getActiveQuestUniqueNo:()=>r.unique});
  host.objects["snow.gui.GuiQuestResultFsmManager"] = obj("result", {}, {getCurrentNodeName:()=>r.node,
    decideSendAllItem:()=>{r.receive++;}});
  host.objects["snow.gui.GuiManager"] = obj("gui", {}, {IsCanInvokeQuestBoard:()=>r.village,
    isOpenResultReward:()=>r.node==="Reward", isOpenResultPayOff:()=>["Payoffselect","Save"].includes(r.node)});
  return {...f,r};
}
it("identifies result pages and waits for native transitions rather than closing windows",()=>{
  const {ui,r}=resultFixture();
  expect(ui.observe().scene).toBe("quest_reward");
  ui.request({id:"receive",cmd:"result.receive",sceneToken:ui.observe().sceneToken});
  expect(r.receive).toBe(1);expect(ui.poll()).toBeNull();
  r.node="Payoffselect";expect(ui.poll()?.status).toBe("applied");
  expect(ui.observe().scene).toBe("quest_payoff");
  ui.request({id:"next",cmd:"result.next",sceneToken:ui.observe().sceneToken});
  expect(signal("getAnyTrgSYS")).toBe(0);
  expect(signal("getDecideButtonTrg")).toBe(1);
  expect(signal("getDecideButtonTrg")).toBe(1);
  r.node="Save";expect(signal("getDecideButtonTrg")).toBe(0);
  expect(ui.poll()?.status).toBe("applied");
  expect(ui.observe().allowedActions).toEqual([]);
});
it("automates only the pinned ended quest and completes on real village readiness",()=>{
  const {ui,r}=resultFixture();ui.beginReturn(900103,7);ui.tickReturn();
  expect(r.receive).toBe(1);ui.tickReturn();expect(r.receive).toBe(1);
  r.node="Payoffselect";ui.poll();host.now++;ui.tickReturn();
  expect(signal("getDecideButtonTrg")).toBe(1);r.node="Save";ui.poll();
  host.now++;ui.tickReturn();expect(ui.observe().returnFlow.state).toBe("waiting");
  r.active=false;r.village=true;r.node="End";host.now++;ui.tickReturn();
  expect(ui.observe().returnFlow.state).toBe("complete");
  ui.beginReturn(900103,7);expect(ui.observe().returnFlow.state).toBe("complete");
});
it("stops result automation on another quest, and never offers it during combat",()=>{
 const {ui,r}=resultFixture();r.playing=true;
 expect(ui.observe().allowedActions).not.toContain("result.receive");
 r.playing=false;expect(()=>ui.beginReturn(900103,8)).toThrow("identity");
 ui.beginReturn(900103,7);r.unique=8;host.now++;ui.tickReturn();
 expect(r.receive).toBe(0);expect(ui.observe().returnFlow.state).toBe("stopped");
 r.quest=10101;expect(ui.observe().allowedActions).not.toContain("result.receive");
});
it("bounds automatic return without forcing saving or unknown UI branches",()=>{
 const {ui,r}=resultFixture();r.node="Save";ui.beginReturn(900103,7);
 host.now+=121;ui.tickReturn();expect(ui.observe().returnFlow.state).toBe("stopped");expect(r.receive).toBe(0);
});

it("does not replay an automatic receive when its outcome is uncertain",()=>{
 const {ui,r}=resultFixture();ui.beginReturn(900103,7);ui.tickReturn();expect(r.receive).toBe(1);
 host.now+=9;expect(ui.poll()?.status).toBe("uncertain");
 ui.tickReturn();expect(r.receive).toBe(1);expect(ui.observe().returnFlow.state).toBe("stopped");
});

it("uses the configured quest rather than a fixed list of test quest IDs", () => {
  const {r} = resultFixture(); r.quest = 900199;
  const ui = new NativeUi("custom", () => 900199);
  expect(ui.observe().allowedActions).toContain("result.receive");
  ui.beginReturn(900199, 7); ui.tickReturn(); expect(r.receive).toBe(1);
  r.quest = 900103;
  expect(ui.observe().allowedActions).not.toContain("result.receive");
  expect(() => new NativeUi("custom", () => 900199).beginReturn(900103, 7)).toThrow("identity");
});
