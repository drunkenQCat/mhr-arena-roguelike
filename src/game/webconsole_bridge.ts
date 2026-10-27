/**
 * Web 控制台桥（Phase-2）—— Lua 侧命令执行与状态发布。
 *
 * 通信模型（webconsole.dll 原生插件承载 HTTP，Phase-1 已实机验证）：
 *   浏览器 → POST /api/command → 插件原子写 webconsole_cmd.json（单命令槽）
 *   本桥：on_frame 限频轮询命令槽 → 执行（与 ImGui 共用 session/runtime/shop）→
 *         结果写 webconsole_results.json → 清空命令槽
 *   状态：限频写 webconsole_state.json（浏览器 GET /api/state 由插件线程读取返回）
 *
 * 会话安全：bridgeId 在构造与脚本重置（Reset scripts）时重新生成；命令必须携带
 * 当前 bridgeId，旧页面/旧命令按过期拒绝。buy 走 ShopWindow 公共请求入口（与 ImGui
 * 同一条 pending→tick 路径：真实发货、背包读回、失败恢复 PT），结果为 queued，
 * 最终结果见 state.shopNotice 与交易日志。
 *
 * 配置热调（Phase-4 最小集）：submitConfig 校验后立即替换 RunCore 配置并落盘
 * mhw_rogue_config.json（持久覆盖，重启亦生效）；生效点遵循简报 §7：
 * 商店价格/怪池/倍率即时影响下一次取值；开局 PT 等在下一局生效。
 */

import { validateConfig, type RogueConfig } from "../core/config";
import type { RunSession } from "../core/run_session";
import type { NativeRuntime } from "./native_runtime";
import type { ShopWindow } from "./shop_window";
import { rejson } from "./sdk";

interface Command
{
    id?: string;
    bridgeId?: string;
    cmd?: string;
    armor?: string;
    index?: number;
    value?: boolean;
    itemId?: string;
    route?: string;
    config?: unknown;
}

const CMD_FILE = "webconsole_cmd.json";
const RESULT_FILE = "webconsole_results.json";
const STATE_FILE = "webconsole_state.json";
const CONFIG_OVERRIDE_FILE = "mhw_rogue_config.json";
const RESULT_HISTORY_MAX = 50;

function randomId(): string
{
    return Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, "0");
}

export class WebConsoleBridge
{
    readonly bridgeId = randomId();
    configVersion = 0;
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

    private publishStateRef: (() => void) | null = null;

    /** Reset scripts / 新装配时轮换会话：旧页面命令全部过期。 */
    newScriptSession(): void
    {
        this.lastExecutedId = null;
        this.results = [];
        rejson.dump_file(RESULT_FILE, { bridgeId: this.bridgeId, rotated: true }, 1);
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
            if (cmd.bridgeId !== undefined && cmd.bridgeId !== this.bridgeId)
            {
                const outcome = { status: "rejected", message: "stale bridgeId" };
                this.results.push({ id, ...outcome });
                this.writeResults(id);
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
            case "submitConfig":
            {
                try
                {
                    const cfg = validateConfig(cmd.config);
                    session.core.replaceConfig(cfg);
                    this.configVersion++;
                    // 持久覆盖：重启/Reset 后仍生效（loadConfig 优先读此文件）
                    rejson.dump_file(CONFIG_OVERRIDE_FILE, cmd.config, 2);
                    return { status: "applied", configVersion: this.configVersion };
                }
                catch (e)
                {
                    return { status: "rejected", message: String(e) };
                }
            }
            case "getConfig":
            {
                // 结果文件带回完整配置（页面也可读 /api/config）
                return { status: "applied", config: session.core.config };
            }
            default:
                return { status: "rejected", message: `unknown cmd ${cmd.cmd ?? "(none)"}` };
        }
    }

    private writeResults(id: string): void
    {
        rejson.dump_file(RESULT_FILE,
            {
                lastId: id,
                last: this.lastOutcome,
                bridgeId: this.bridgeId,
                configVersion: this.configVersion,
                history: this.results,
            }, 2);
    }

    private publishState(): void
    {
        const s = this.session;
        const state = s.core.state;
        this.stateCounter++;
        // 商店目录体积大（50 项×校验字段）：仅在 (配置版本, PT, 交易锁) 变化时重算，
        // 其余轮次复用缓存——避免 2Hz 全量序列化（简报 §8）
        const shopKey = `${this.configVersion}:${state.wallet.pt}:${this.shop.busy}`;
        if (shopKey !== this.lastShopKey)
        {
            this.shopCache = s.core.getShop();
            this.lastShopKey = shopKey;
        }
        rejson.dump_file(STATE_FILE, {
            ok: true,
            protocol: 2,
            counter: this.stateCounter,
            bridgeId: this.bridgeId,
            configVersion: this.configVersion,
            sessionStage: s.stage,
            corePhase: state.phase,
            questId: s.core.config.quest.id,
            questUnique: s.questUniqueSnapshot,
            layer: state.layer,
            pt: state.wallet.pt,
            cartsLeft: state.cartsLeft,
            maxCarts: s.core.config.maxCarts,
            armor: state.armor,
            invincible: this.runtime.testTools.invincible,
            activeWave: state.activeWave?.label ?? null,
            choices: state.currentChoices,
            shop: this.shopCache,
            shopNotice: this.shop.notice,
            shopBusy: this.shop.busy,
            message: s.message,
        }, 1);
    }

    private lastShopKey = "";
    private shopCache: Record<string, Array<{ id: string; name: string; category: string; price: number; cap: number; owned: number; mode: string; desc: string | null; canBuy: boolean; reason: string | null }>> = {};
}
