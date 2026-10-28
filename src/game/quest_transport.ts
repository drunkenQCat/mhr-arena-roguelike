/** Native quest-counter transport, bounded to one explicitly prepared solo quest.
 * Engine API names were checked against local RTTI / community API usage. No input injection.
 */
import { snow_LobbyFacilityUIManager_SceneId } from "./gen/enums/snow_LobbyFacilityUIManager_SceneId";
import { snow_gui_fsm_questcounter_GuiQuestCounterFsmManager_QuestCounterAccessType } from "./gen/enums/snow_gui_fsm_questcounter_GuiQuestCounterFsmManager_QuestCounterAccessType";
import { snow_gui_GuiCommonSelectWindow_Result } from "./gen/enums/snow_gui_GuiCommonSelectWindow_Result";
import { snow_gui_GuiManager_YNInfoResult } from "./gen/enums/snow_gui_GuiManager_YNInfoResult";
import { snow_gui_SnowGuiCommonUtility_BaseBranchValue } from "./gen/enums/snow_gui_SnowGuiCommonUtility_BaseBranchValue";
import {
  clockSeconds, createInstance, findTypeDefinition, getSingleton, hookMethod, PRE_HOOK,
  questManager, retain, toManagedObject, toPtr, type REManagedObject,
} from "./sdk";

function callNative(object: REManagedObject, name: string, ...args: unknown[]): unknown {
  try { return object.call(name, ...args); }
  catch (error) { throw new Error(`${name}: ${String(error)}`); }
}

const COUNTER = "snow.gui.fsm.questcounter.GuiQuestCounterFsmManager";
type PostStage = "Idle" | "Open" | "WaitCounter" | "Confirm" | "Close" | "Depart" | "AwaitEntry";

export class QuestTransport {
  private stage: PostStage = "Idle";
  private target = 0;
  private deadline = 0;
  private action: REManagedObject | null = null;
  private held: REManagedObject[] = [];
  private hooks = false;
  private error: string | null = null;
  private lastSelection: unknown = null;

  constructor(private readonly currentQuest: () => REManagedObject | null, private readonly timeout: number) {}
  isActive(): boolean { return this.stage !== "Idle"; }

  /**
   * Re-point the transport at the configured quest after a stopped run left its
   * quest registered (status failed/return). Keeps hooks/retained refs intact.
   */
  retarget(id: number): void {
    if (this.isActive()) return;
    this.target = id;
  }
  getError(): string | null { return this.error; }
  getStatus(): string { return this.error ?? this.stage; }

  request(id: number): void {
    if (this.isActive()) throw new Error("Quest post already running");
    const qm = questManager();
    const gui = getSingleton("snow.gui.GuiManager");
    // isActiveQuest still reports a stopped run's quest until the counter is invoked
    // again; the counter path can replace it, so only the UI availability matters here.
    if (!qm || !gui || (callNative(gui, "IsCanInvokeQuestBoard") !== true && !getSingleton(COUNTER))) {
      throw new Error("Quest counter is not available; retry from the village");
    }
    this.installHooks();
    this.error = null;
    this.target = id;
    this.lastSelection = null;
    this.deadline = clockSeconds() + this.timeout;
    this.stage = getSingleton(COUNTER) ? "WaitCounter" : "Open";
  }

  cancel(closeWindows = true): void {
    const owned = this.isActive();
    this.stage = "Idle"; // release every global hook predicate BEFORE closing UI
    this.error = null;
    if (owned && closeWindows) {
      const gui = getSingleton("snow.gui.GuiManager");
      const facility = getSingleton("snow.LobbyFacilityUIManager");
      try {
        gui?.call("closeYNInfo");
        gui?.call("closeSelectWindow");
        gui?.call("closeServantSelectInfoWindow");
        facility?.call("deactivateOnly", snow_LobbyFacilityUIManager_SceneId.QuestCounter);
      } catch { /* hooks are already inactive even if the game destroyed the counter */ }
    }
    for (const object of this.held) object.release();
    this.held = [];
    this.action = null;
  }

  tick(): void {
    if (!this.isActive()) return;
    try {
      if (clockSeconds() > this.deadline) throw new Error(`Quest posting timed out in ${this.stage}`);
      const qm = questManager();
      // Village UI managers disappear during loading. Once departure is requested,
      // wait only for the quest manager to report entry, within the same deadline.
      if (this.stage === "AwaitEntry") {
        if (qm && callNative(qm, "isPlayQuest")) this.cancel(false);
        return;
      }
      const gui = getSingleton("snow.gui.GuiManager");
      const facility = getSingleton("snow.LobbyFacilityUIManager");
      if (!qm || !gui || !facility) return;
      if (callNative(qm, "isActiveQuest") && callNative(qm, "get_ActiveQuestNo") !== this.target &&
          callNative(qm, "isPlayQuest") === true) {
        throw new Error("Another quest was accepted; stopping automatic transport");
      }
      if (this.stage === "Open") {
        callNative(gui, "set_IsActivateQuestCounterFromQuestBoard", false);
        callNative(facility, "activateOnly", snow_LobbyFacilityUIManager_SceneId.QuestCounter);
        this.stage = "WaitCounter";
        return;
      }
      const counter = getSingleton(COUNTER);
      if (this.stage === "WaitCounter") {
        if (!counter) return;
        const action = createInstance("snow.gui.fsm.questcounter.GuiQuestCounterFsmCreateQuestSessionAction", true);
        const arg = createInstance("via.behaviortree.ActionArg", true);
        if (!action || !arg) throw new Error("Cannot create native quest session action");
        this.action = retain(action, this.held);
        callNative(action, ".ctor");
        retain(arg, this.held);
        const tree = callNative(counter, "get_refQuestCounterBehaviorTree") as REManagedObject;
        if (!tree) throw new Error("Quest counter behavior tree missing");
        callNative(arg, "setOwnerComponentPtr", tree.get_address());
        callNative(this.action, "start", arg);
        this.stage = "Confirm";
      }
      if (this.stage === "Confirm") {
        // Explicit native cursor/results; no screen coordinates or simulated keys.
        let select: REManagedObject | null = null;
        if (callNative(gui, "isOpenServantSelectInfoWindow")) select = callNative(gui, "get_refGuiServantSelectInfoWindow") as REManagedObject;
        else if (callNative(gui, "isOpenSelectInfo")) select = callNative(gui, "get_refGuiCommonSelectWindow") as REManagedObject;
        if (select && toPtr(select) !== this.lastSelection) {
          const scroll = select.get_field("_ScrollListCtrl") as REManagedObject;
          const cursor = scroll?.get_field("_Cursor") as REManagedObject;
          if (!scroll || !cursor) throw new Error("Native quest selection controls missing");
          callNative(cursor, "set_index", 0); // solo / no join request
          scroll.set_field("_result", snow_gui_GuiCommonSelectWindow_Result.Decide);
          this.lastSelection = toPtr(select);
        }
        if (this.action) {
          const routine = this.action.get_field("_RoutineCtrl") as REManagedObject | null;
          if (routine) {
            let executable: unknown;
            try { executable = callNative(routine, "isExecute"); }
            catch (error) { throw new Error(`Native routine.isExecute: ${String(error)}`); }
            if (executable) {
              try { callNative(routine, "execute"); }
              catch (error) { throw new Error(`Native routine.execute: ${String(error)}`); }
            }
          }
        }
        const branch = counter?.call("get_BaseBranchValue");
        if (branch === snow_gui_SnowGuiCommonUtility_BaseBranchValue.FAILED ||
            branch === snow_gui_SnowGuiCommonUtility_BaseBranchValue.CANCELED) throw new Error("Native quest selection failed/canceled");
        if (callNative(qm, "isActiveQuest") && callNative(qm, "get_ActiveQuestNo") === this.target) {
          callNative(facility, "deactivateOnly", snow_LobbyFacilityUIManager_SceneId.QuestCounter);
          this.stage = "Close";
        }
      } else if (this.stage === "Close") {
        if (!counter) this.stage = "Depart";
      } else if (this.stage === "Depart") {
        const flow = callNative(gui, "get_refQuestStartFlowHandler") as REManagedObject;
        if (!flow) throw new Error("Native quest departure flow missing");
        callNative(flow, "requestGoQuest", true);
        this.stage = "AwaitEntry";
      }
    } catch (error) {
      const message = String(error);
      this.cancel();
      this.error = message;
    }
  }

  private installHooks(): void {
    if (this.hooks) return;
    const lookup = (type: string, name: string) => {
      const method = findTypeDefinition(type)?.get_method(name);
      if (!method) throw new Error(`Native quest transport API missing: ${type}.${name}`);
      return method;
    };
    // Preflight all required hooks before installing any. Missing APIs leave a usable manual path.
    const selected = lookup(COUNTER, "getQuestCounterSelectedQuest");
    const awake = lookup(COUNTER, "awake");
    const input = lookup("snow.gui.GuiManager", "IsPlayerAllInputDisable");
    const confirm = lookup("snow.gui.GuiManager", "updateYNInfoWindow(System.UInt32)");
    const top = "snow.gui.fsm.questcounter.GuiQuestCounterFsmTopMenuAction";
    const start = lookup(top, "start(via.behaviortree.ActionArg)");
    const update = lookup(top, "update(via.behaviortree.ActionArg)");
    hookMethod(selected, () => {}, (retval) => this.isActive() && this.currentQuest() ? toPtr(this.currentQuest()) : retval);
    hookMethod(awake, (args) => {
      if (this.isActive()) toManagedObject(args[2]).call("set_QuestCounterType",
        snow_gui_fsm_questcounter_GuiQuestCounterFsmManager_QuestCounterAccessType.VillageCounter);
      return PRE_HOOK.CALL_ORIGINAL;
    });
    hookMethod(input, () => {}, (retval) => this.isActive() ? toPtr(1) : retval);
    hookMethod(confirm, () => {}, (retval) => this.stage === "Confirm"
      ? toPtr(snow_gui_GuiManager_YNInfoResult.Yes) : retval);
    hookMethod(start, () => this.isActive() ? PRE_HOOK.SKIP_ORIGINAL : PRE_HOOK.CALL_ORIGINAL);
    hookMethod(update, () => this.isActive() ? PRE_HOOK.SKIP_ORIGINAL : PRE_HOOK.CALL_ORIGINAL);
    this.hooks = true;
  }
}

