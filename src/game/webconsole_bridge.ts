/**
 * Web 控制台桥（Phase-1 phase B）—— Lua 侧命令执行与状态发布。
 *
 * 通信模型（webconsole.dll 原生插件已承载 HTTP）：
 *   浏览器 → POST /api/command → 插件原子写 webconsole_cmd.json（单命令槽）
 *   本桥：on_frame 限频轮询命令槽 → 执行（与 ImGui 共用 session/runtime/shop）→
 *         结果写 webconsole_results.json → 清空命令槽
 *   状态：限频写 webconsole_state.json（浏览器 GET /api/state 由插件线程读取返回）
 *
 * 协议：命令 { id, cmd, ... }，显式设置（setInvincible: true）避免重试副作用。
 * 结果：{ id, status: "applied"|"rejected"|"queued", message }。
 * buy 为 queued（购买经 ShopWindow.tick 异步执行，最终结果在 state.notice/交易日志）。
 * 安全：单槽天然串行；id 去重（重复 id 直接回最近结果不重复执行）；命令槽只由本桥清空。
 */

import type { RunSession } from "../core/run_session";
import type { NativeRuntime } from "./native_runtime";
import type { ShopWindow } from "./shop_window";
import { rejson } from "./sdk";

interface Command
{
    id?: string;
    cmd?: string;
    armor?: string;
    index?: number;
    value?: boolean;
    itemId?: string;
    route?: string;
}

const CMD_FILE = "webconsole_cmd.json";
const RESULT_FILE = "webconsole_results.json";
const STATE_FILE = "webconsole_state.json";
const RESULT_HISTORY_MAX = 20;

export class WebConsoleBridge
{
    private lastExecutedId: string | null = null;
    private lastOutcome: Record<string, unknown> = { status: "applied", message: "none" };
    private frameCounter = 0;
    private results: Array<Record<string, unknown>> = [];
    private stateCounter = 0;

    constructor(private readonly session: RunSession,
        private readonly runtime: NativeRuntime,
        private readonly shop: ShopWindow)
    {
    }

    tick(): void
    {
        this.frameCounter++;
        if (this.frameCounter % 12 === 0) this.pollCommand();   // ~5Hz @60fps
        if (this.frameCounter % 30 === 0) this.publishState();  // ~2Hz
    }

    private pollCommand(): void
    {
        try
        {
            const raw = rejson.load_file(CMD_FILE);
            if (!raw || typeof raw !== "object") return;
            const cmd = raw as Command;
            const id = typeof cmd.id === "string" ? cmd.id : null;
            if (id === null) return;

            if (id === this.lastExecutedId)
            {
                // 槽未被清空（结果写失败等）：重发最近结果并清槽，绝不重复执行
                this.writeResults(id);
                rejson.dump_file(CMD_FILE, {}, 1);
                return;
            }
            this.lastExecutedId = id;

            const outcome = this.execute(cmd);
            this.lastOutcome = outcome;
            this.results.push({ id, ...outcome });
            if (this.results.length > RESULT_HISTORY_MAX) this.results.shift();
            this.writeResults(id);
            rejson.dump_file(CMD_FILE, {}, 1);
        }
        catch
        {
            // 坏 JSON（读写竞争窗口）等：静默跳过，下轮重读（槽仍在）
        }
    }

    private execute(cmd: Command): Record<string, unknown>
    {
        const session = this.session;
        switch (cmd.cmd)
        {
            case "startRun":
            {
                const armor = cmd.armor ?? session.core.armorOptions()[0] ?? "";
                const r = session.start(armor);
                return { status: r.ok ? "applied" : "rejected", message: r.message ?? "" };
            }
            case "choose":
            {
                const r = session.choose(cmd.index ?? 0);
                return { status: r.ok ? "applied" : "rejected", message: r.message ?? "" };
            }
            case "setInvincible":
            {
                const want = cmd.value === true;
                if (this.runtime.testTools.invincible !== want) this.runtime.testTools.toggleGod();
                return { status: "applied", invincible: this.runtime.testTools.invincible };
            }
            case "killAll":
            {
                this.runtime.testTools.requestKill();
                return { status: "applied", message: "kill requested for spawned bosses" };
            }
            case "buy":
            {
                if (!cmd.itemId) return { status: "rejected", message: "itemId required" };
                const r = this.shop.requestPurchase(cmd.itemId);
                // 购买异步执行（ShopWindow.tick），最终结果见 state.notice 与交易日志
                return { status: r.ok ? "queued" : "rejected", message: r.message };
            }
            case "retryPost":
            {
                const r = session.retryPost();
                return { status: r.ok ? "applied" : "rejected", message: r.message ?? "" };
            }
            case "stop":
            {
                session.stop();
                return { status: "applied", message: "run stopped" };
            }
            case "setRoute":
            {
                if (cmd.route !== "reentry" && cmd.route !== "inPlace")
                    return { status: "rejected", message: "route must be reentry|inPlace" };
                session.settings.route = cmd.route;
                session.route = cmd.route;
                return { status: "applied", message: cmd.route };
            }
            default:
                return { status: "rejected", message: `unknown cmd ${cmd.cmd ?? "(none)"}` };
        }
    }

    private writeResults(id: string): void
    {
        rejson.dump_file(RESULT_FILE,
            { lastId: id, last: this.lastOutcome, history: this.results }, 2);
    }

    private publishState(): void
    {
        const s = this.session;
        const state = s.core.state;
        this.stateCounter++;
        rejson.dump_file(STATE_FILE, {
            ok: true,
            protocol: 1,
            counter: this.stateCounter,
            sessionStage: s.stage,
            corePhase: state.phase,
            layer: state.layer,
            pt: state.wallet.pt,
            cartsLeft: state.cartsLeft,
            maxCarts: s.core.config.maxCarts,
            armor: state.armor,
            invincible: this.runtime.testTools.invincible,
            activeWave: state.activeWave?.label ?? null,
            choices: state.currentChoices,
            shopNotice: this.shop.notice,
            shopBusy: this.shop.busy,
            message: s.message,
        }, 1);
    }
}
