/** Installed 5bae4701 UI adapter. Commands inject a bounded frame of native UI confirmation;
 * they do not force FSM branches, call load/save routines, or synthesize OS keys. */
import { clockSeconds, findTypeDefinition, getSingleton, hookMethod, PRE_HOOK,
  reframework, toManagedObject, toPtr, type REManagedArray, type REManagedObject } from "./sdk";

const TITLE = "snow.gui.fsm.title.GuiTitleFsmManager";
const MENU = "snow.gui.fsm.title.GuiTitleMenuFsmManager";
const RESULT = "snow.gui.GuiQuestResultFsmManager";
function call(o: REManagedObject | null, name: string, ...args: unknown[]): any {
  try { return o?.call(name, ...args) ?? null; } catch { return null; }
}
function field(o: REManagedObject | null, name: string): any {
  try { return o?.get_field(name) ?? null; } catch { return null; }
}
export interface UiIntent { id?: string; cmd?: string; sceneToken?: string; dialogToken?: string; slot?: number; }
interface UiSnapshot extends Record<string, any> {
  scene: string; sceneToken: string; allowedActions: string[];
  dialogs: { token?: string; kind: string; text: string | null; supported: boolean; passive: boolean; identity: string; windowType: unknown; buttons: string[] }[];
  slots: { slot: number; occupied: boolean; name: unknown; hunterRank: unknown; masterRank: unknown }[];
}
type Pending = { id: string; action: string; token: string; before: string; deadline: number; consumed: boolean; pulseActive: boolean; internal?: boolean };

export class NativeUi {
  private revision = 0;
  private fingerprint = "";
  private hooks = false;
  private contexts: Record<number, string[][]> = {};
  private pending: Pending | null = null;
  private diagnostics: Record<string, number> = {};
  private returning: { questId: number; unique: number; deadline: number; lastPoll: number;
    state: "waiting" | "complete" | "stopped"; message: string; step: number } | null = null;

  /** Armed only by an ended owned run, never by observing an arbitrary result UI. */
  beginReturn(questId: number, unique: number): void {
    if (this.returning?.questId === questId && this.returning.unique === unique) return;
    const q = getSingleton("snow.QuestManager");
    if (questId !== this.ownedQuestId() || call(q, "get_ActiveQuestNo") !== questId ||
        call(q, "getActiveQuestUniqueNo") !== unique) throw new Error("Return quest identity changed");
    this.returning = { questId, unique, deadline: clockSeconds() + 120, lastPoll: -1,
      state: "waiting", message: "等待原生结算与返回", step: 0 };
  }

  tickReturn(): void {
    const r = this.returning, now = clockSeconds();
    if (!r || r.state !== "waiting" || r.lastPoll === now) return;
    r.lastPoll = now;
    const view = this.observe(), q = getSingleton("snow.QuestManager");
    if (view.scene === "village") { r.state = "complete"; r.message = "已通过原生结算返回村庄"; return; }
    if (now > r.deadline) { r.state = "stopped"; r.message = "回村等待超时，请查看原生界面"; return; }
    if (call(q, "isActiveQuest") === true && (call(q, "get_ActiveQuestNo") !== r.questId ||
        call(q, "getActiveQuestUniqueNo") !== r.unique)) {
      r.state = "stopped"; r.message = "任务身份改变，停止结算操作"; return;
    }
    if (this.pending) return;
    if (r.step >= 12) { r.state = "stopped"; r.message = "结算步骤未正常推进，请查看原生界面"; return; }
    const action = view.allowedActions.find(a => ["result.receive", "result.next", "dialog.close"].includes(a));
    if (!action) { r.message = view.dialogs.length > 0 ? "等待处理未识别的原生弹窗" : "等待原生结算与保存完成"; return; }
    this.request({ id: `return-${r.unique}-${++r.step}`, cmd: action, sceneToken: view.sceneToken,
      dialogToken: action === "dialog.close" ? view.dialogs.find(d => d.supported)?.token : undefined }, true);
    r.message = action === "result.receive" ? "领取原生任务奖励" : action === "result.next" ? "确认原生结算" : "关闭连接结束提示";
  }
  constructor(private readonly bridge: string, private readonly ownedQuestId: () => number) {}

  observe(): UiSnapshot {
    const gm = getSingleton("snow.gui.GuiManager");
    const title = getSingleton(TITLE), menu = getSingleton(MENU);
    const node = call(title, "getCurrentNodeName", 0) as string | null;
    const menuNode = call(menu, "getCurrentNodeName", 0) as string | null;
    const menuState = call(menu, "get_TitleMenuState");
    const beforeTitle = call(title, "get_IsBeforeTitleMenu");
    const save = call(gm, "get_refGuiSaveDataSelectMenu") as REManagedObject | null;
    const q = getSingleton("snow.QuestManager");
    const villageReady = call(gm, "IsCanInvokeQuestBoard") === true && call(q, "isActiveQuest") === false;
    const resultNode = call(getSingleton(RESULT), "getCurrentNodeName", 0);
    const endedOwned = call(q, "get_ActiveQuestNo") === this.ownedQuestId() && call(q, "isPlayQuest") === false;
    const reward = endedOwned && resultNode === "Reward" && call(gm, "isOpenResultReward") === true;
    const payoff = endedOwned && resultNode === "Payoffselect" && call(gm, "isOpenResultPayOff") === true;
    const saveOpen = call(save, "isOpen") === true && !villageReady;
    const dialogs: UiSnapshot["dialogs"] = [];
    for (const [getter, kind] of [["get_refGuiNetworkErrorWindow", "network_error"],
      ["get_refGuiCommonYNInfoWindow", "confirmation"], ["get_refGuiCommonInfoWindow", "information"]]) {
      const win = call(gm, getter!) as REManagedObject | null;
      if (call(win, "isOpen") !== true) continue;
      const text = call(win, "getText") ?? call(field(win, "_YNInfoText"), "get_Message") ?? null;
      const safe = kind === "network_error" && typeof text === "string" && (text.includes("MR-111-83") || text === "由于一段时间内未进行操作，\r\n已断开连接。") && call(win, "get_WindowType") === 1;
      dialogs.push({ kind: kind!, text, windowType: call(win, "get_WindowType"),
        supported: safe, passive: [2, 3, 5].includes(call(win, "get_WindowType")), buttons: safe ? ["close"] : [], identity: String(win?.get_address()) });
    }
    let scene = "unknown";
    if (villageReady) scene = "village";
    else if (dialogs.some(d => d.passive)) scene = "loading";
    else if (reward) scene = "quest_reward";
    else if (payoff) scene = "quest_payoff";
    else if (endedOwned && ["Save", "BeforeSave"].includes(resultNode) && call(gm, "isOpenResultPayOff") === true) scene = "quest_result_wait";
    else if (saveOpen) scene = node === "ロード画面初期化" ? "save_select" : "save_menu_unknown";
    else if (node === "AutoSaveCaution") scene = "autosave_notice";
    else if (menuState === 1 || node === "PressAnyButton") scene = "title_press";
    else if (menuState === 2 && call(menu, "isOpenTitle") === true) scene = "title";
    const fingerprint = `${scene}|${node}|${menuNode}|${menuState}|${resultNode}|${call(q, "getActiveQuestUniqueNo")}|${dialogs.map(d => `${d.identity}:${d.text}`).join("|")}`;
    if (fingerprint !== this.fingerprint) { this.fingerprint = fingerprint; this.revision++; }
    const sceneToken = `${this.bridge}:ui:${this.revision}`;
    for (let i = 0; i < dialogs.length; i++) dialogs[i]!.token = `${sceneToken}:dialog:${i}`;
    const slots: UiSnapshot["slots"] = [];
    const data = field(save, "_SlotDataArray") as REManagedArray | null;
    if (saveOpen && data) {
      try {
        for (let i = 0; i < Math.min(data.get_size(), 3); i++) {
          const entry = data.get_element(i) as REManagedObject | null;
          const name = field(entry, "_HunterName");
          slots.push({ slot: i + 1, occupied: typeof name === "string" && name.length > 0 && (field(entry, "_HunterRank") as number) >= 1,
            name, hunterRank: field(entry, "_HunterRank"), masterRank: field(entry, "_MasterRank") });
        }
      } catch { /* No invented slots during loading. */ }
    }
    return { adapterVersion: 1, scene, sceneToken, resultNode, returnFlow: this.returning, diagnostics: this.diagnostics, titleNode: node, menuNode, menuState, beforeTitle,
      dialogs, dialogsKnown: false, dialogCoverage: ["network_error", "confirmation", "information"],
      slots, selectedSlot: saveOpen ? (field(save, "_CurrentSlotNo") as number) + 1 : null,
      loading: scene === "loading" ? true : null, busy: this.pending !== null,
      allowedActions: dialogs.length > 0 ? dialogs.filter(d => d.supported).map(() => "dialog.close")
        : scene === "quest_reward" ? ["result.receive"]
        : scene === "quest_payoff" ? ["result.next"]
        : scene === "autosave_notice" ? ["startup.acknowledge"]
        : scene === "title_press" ? ["title.advance"]
        : scene === "title" ? ["title.continue"]
        : scene === "save_select" && slots.some(s => s.occupied) ? ["save.load"] : [],
      evidence: [{ source: `${TITLE}.getCurrentNodeName(0)`, value: node },
        { source: `${MENU}.get_TitleMenuState`, value: menuState },
        { source: "snow.gui.GuiSaveDataSelectMenu.isOpen", value: saveOpen }],
    };
  }

  request(cmd: UiIntent, internal = false): Record<string, unknown> {
    if (this.pending) throw new Error("UI operation already pending");
    const ui = this.observe();
    if (cmd.sceneToken !== ui.sceneToken) throw new Error("UI scene changed; inspect again");
    if (!ui.allowedActions.includes(cmd.cmd ?? "")) throw new Error("UI action unsupported or blocked");
    let token = ui.sceneToken;
    if (cmd.cmd === "dialog.close") {
      const dialog = ui.dialogs.find((d: any) => d.token === cmd.dialogToken && d.supported);
      if (!dialog) throw new Error("Dialog changed or unsupported");
      token = dialog.token!;
    }
    this.installHooks();
    const gm = getSingleton("snow.gui.GuiManager");
    if (cmd.cmd === "title.continue") {
      const cursor = call(getSingleton(MENU), "get_TitleMenuCursor") as REManagedObject | null;
      if (!cursor) throw new Error("Title cursor unavailable");
      // Installed title menu: Continue is index 1 (RTTI TitleMenu enum and observed title menu).
      call(cursor, "set_index", 1);
    }
    if (cmd.cmd === "save.load") {
      if (!Number.isInteger(cmd.slot) || !ui.slots.some((s: any) => s.slot === cmd.slot && s.occupied))
        throw new Error("Select an existing save slot (1..3)");
      const save = call(gm, "get_refGuiSaveDataSelectMenu") as REManagedObject | null;
      if (!save) throw new Error("Save menu unavailable");
      save.set_field("_CurrentSlotNo", cmd.slot! - 1);
    }
    this.pending = { id: cmd.id!, action: cmd.cmd!, token, before: ui.sceneToken,
      deadline: clockSeconds() + 8, consumed: false, pulseActive: false, internal };
    if (cmd.cmd === "result.receive") {
      // Native receive-all callback advances Reward -> Payoff; closing the GUI does not.
      call(getSingleton(RESULT), "decideSendAllItem");
      this.pending.consumed = true;
    }
    return { status: "queued", message: "Waiting for scoped native UI input and state transition" };
  }

  poll(): Record<string, unknown> | null {
    const p = this.pending;
    if (!p) return null;
    if (p.consumed) p.pulseActive = false;
    const ui = this.observe();
    if (p.consumed && ui.sceneToken !== p.before) {
      this.pending = null;
      ui.busy = false;
      return { id: p.id, internal: p.internal === true, status: "applied", message: "Native UI transitioned", ui };
    }
    if (clockSeconds() > p.deadline) {
      if (this.returning && p.id.startsWith(`return-${this.returning.unique}-`)) {
        this.returning.state = "stopped";
        this.returning.message = "结算输入结果未确认，请查看原生界面；不会自动重试";
      }
      this.pending = null;
      return { id: p.id, internal: p.internal === true, status: p.consumed ? "uncertain" : "rejected",
        message: p.consumed ? "UI input consumed; transition unconfirmed" : "Native UI did not consume the scoped input", diagnostics: this.diagnostics };
    }
    return null;
  }

  private installHooks(): void {
    if (this.hooks) return;
    const contexts: [string, string, string[]][] = [
      ["snow.gui.GuiManager", "updateInfoWindowSYS", ["startup.acknowledge"]],
      ["snow.gui.fsm.title.GuiGameStartFsm_AutoSaveCaution_Action", "update", ["startup.acknowledge"]],
      ["snow.gui.fsm.title.GuiTitleFsm_PressAnyButton_Action", "update", ["title.advance"]],
      ["snow.gui.fsm.title.GuiTitleFsm_TitleMenu_Action", "update", ["title.continue"]],
      ["snow.gui.GuiSaveDataSelectMenu", "routineLoadDataSelect", ["save.load"]],
    ];
    for (const [type, name, actions] of contexts) {
      const method = findTypeDefinition(type)?.get_method(name);
      if (!method) continue;
      hookMethod(method, () => {
        const tid = reframework.getThreadId();
        (this.contexts[tid] ??= []).push(actions);
        return PRE_HOOK.CALL_ORIGINAL;
      }, value => { this.contexts[reframework.getThreadId()]?.pop(); return value; });
    }
    const input = findTypeDefinition("snow.gui.StmGuiInput");
    for (const name of ["getDecideButtonTrg", "getDecideButtonTrgSYS", "getAnyTrgSYS",
      "getTitlePressAnyButton", "isNetworkErrorWindowButton", "getDecideMouseEventTrg"]) {
      const method = input?.get_method(name);
      if (!method) continue;
      hookMethod(method, (args) => {
        const p = this.pending;
        if (p) this.diagnostics[name] = (this.diagnostics[name] ?? 0) + 1;
        const stack = this.contexts[reframework.getThreadId()] ?? [];
        const scope = stack[stack.length - 1];
        let active = !!p && (!p.consumed || p.pulseActive) && clockSeconds() <= p.deadline &&
          (scope?.includes(p.action) === true || name === "isNetworkErrorWindowButton" && p.action === "dialog.close"
            || ["getDecideButtonTrg", "getDecideButtonTrgSYS", "getDecideMouseEventTrg"].includes(name) &&
              ["title.continue", "result.next"].includes(p.action));
        if (active && p && name === "getDecideMouseEventTrg" && p.action === "title.continue") {
          const cursor = call(getSingleton(MENU), "get_TitleMenuCursor") as REManagedObject | null;
          const target = field(cursor, "<mouseCtrl>k__BackingField") as REManagedObject | null;
          try { active = !!target && toManagedObject(args[2]).get_address() === target.get_address(); }
          catch { active = false; }
        }
        if (active && p) {
          const ui = this.observe();
          active = ui.sceneToken === p.before && (p.action !== "title.continue" ||
            ui.scene === "title" && field(call(getSingleton(MENU), "get_TitleMenuCursor"), "<index>k__BackingField") === 1) &&
            (p.action !== "result.next" || ui.scene === "quest_payoff") && (p.action !== "dialog.close" ||
            ui.dialogs.some((d: any) => d.token === p.token && d.supported));
        }
        reframework.getHookStorage().cliUiInject = active ? p?.id : null;
        return PRE_HOOK.CALL_ORIGINAL;
      }, value => {
        const id = reframework.getHookStorage().cliUiInject;
        if (id && this.pending?.id === id && (!this.pending.consumed || this.pending.pulseActive)) {
          this.pending.consumed = true;
          this.pending.pulseActive = true;
          return toPtr(1);
        }
        return value;
      });
    }
    this.hooks = true;
  }
}
