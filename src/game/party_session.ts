/**
 * PartySession —— 离线队友调研（research-offline-teammate.md）的最小混合实机切片。
 * 职责（对应调研文档 §4 建议结构的子集）：
 *  - 权威参战名单：开局锁定（host + mock），人数通过 SessionPort.partySize 进入
 *    生成倍率；mock 玩家不伪造原生 online/players（混合模式两套事实分开发布）。
 *  - mock 玩家虚拟账本：PT/背包/限购按 config.shop 规则结算，绝不触原生背包；
 *    真人房主的钱包仍由 RunCore 持有。
 *  - 命令去重：同 playerId+requestId 同载荷返回旧结果，同键异载荷拒绝（最小版）。
 *  - JSON 往返：对外快照一律深拷贝，证明无共享引用（调研文档 §4 要求）。
 * 不在本切片内：网络故障队列、增量同步、远端客户端连接绑定（调研文档 §6 B/C 后续）。
 */

import { clockSeconds } from "./sdk";
import type { OwnedItem, PlayerWallet } from "../core/run_state";
import type { RogueConfig } from "../core/config";

export interface PartyMember {
  playerId: string;
  host: boolean;
  wallet: PlayerWallet;
  joinedLayer: number;
}

export interface PartyBuyResult {
  ok: boolean;
  message: string;
  pt?: number;
  owned?: number;
  duplicate?: boolean;
}

export interface PartySnapshot {
  runId: string;
  /** 评审二轮 #1：会话代数。命令必须回传；服务端拒绝旧代。 */
  generation: number;
  revision: number;
  members: PartyMember[];
}

export interface PartyPort {
  /** 当前层（mock 记录 joinedLayer 用）。 */
  layer(): number;
}

const DEDUPE_TTL_S = 10 * 60;
/** 评审二轮 #4：墓碑集合容量上限。防重放窗口 = min(TTL, 容量)。 */
const EXPIRED_CAP = 4096;

interface DedupeRecord {
  /** 载荷指纹：防同键异载荷重放。 */
  fingerprint: string;
  at: number;
  result: PartyBuyResult;
}

/** 评审 #1：业务事务键必须包含玩家身份——传输 id 只是传输回执键，
 * 绝不能充当跨玩家的事务键。键 = generation|runId|playerId|requestId，
 * 代数轮换后旧键物理上不再命中（旧记录已整体清空）。 */
function txKey(generation: number, runId: string, playerId: string, requestId: string): string {
  return `${generation}|${runId}|${playerId}|${requestId}`;
}

/** 游戏环境没有 JS 标准库全局（JSON/Array/Date 在 TSTL 下原样保留、
 * 游戏沙箱里都是 nil，实机已复现），深拷贝只能用 lualib 自带助手手写：
 * Array.isArray→__TS__ArrayIsArray、Object.entries→__TS__ObjectEntries。
 * 快照数据只有平对象/数组/原始值，无 Date。 */
function deepCopy<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => deepCopy(item)) as unknown as T;
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = deepCopy(v as unknown);
    return out as T;
  }
  return value;
}

export class PartySession {
  private players: PartyMember[] = [];
  private runId: string;
  private revision = 0;
  private dedupe = new Map<string, DedupeRecord>();
  /** 已过 TTL 淘汰的事务键：同键再来的请求按"过旧"拒绝（评审 #6）。 */
  private expired = new Set<string>();
  /** 评审 #2/#3：会话代数。reset 必轮换；旧代请求一律拒绝。 */
  private generation = 1;


  constructor(private readonly config: RogueConfig, private readonly port: PartyPort,
    runId: string) {
    this.runId = runId;
  }

  get active(): boolean { return this.players.length > 0; }

  /** 开局锁定名单：host 必须在列；mock 以 p2..pN 生成。重复 create 拒绝。 */
  create(hostPlayerId: string, mockCount: number): { ok: boolean; message: string } {
    if (this.players.length > 0) return { ok: false, message: "名册已锁定；先 reset 再重建" };
    if (!Number.isInteger(mockCount) || mockCount < 1 || mockCount > 3) {
      return { ok: false, message: "mock 玩家数必须是 1..3（总计 2..4 人）" };
    }
    this.players.push(this.member(hostPlayerId, true));
    for (let i = 2; i <= mockCount + 1; i++) {
      this.players.push(this.member(`p${i}`, false));
    }
    this.bump();
    return { ok: true, message: `名册锁定：${this.players.map((p) => p.playerId).join(", ")}` };
  }

  private member(playerId: string, host: boolean): PartyMember {
    return { playerId, host,
      wallet: { pt: this.config.startPt, bag: [], purchaseLog: [] },
      joinedLayer: this.port.layer() };
  }

  rosterSize(): number | null {
    return this.players.length > 0 ? this.players.length : null;
  }

  memberIds(): string[] {
    return this.players.map((p) => p.playerId);
  }

  /** mock 玩家虚拟购买：按 config.shop 结算，只动该玩家的虚拟账本。
   * host 账本是测试影子账本（评审 #4），与真人钱包无关，但为保护真人
   * 钱包语义，host 的虚拟购买一律拒绝。
   * 评审二轮 #1：generation 由命令显式携带，服务端按代数拒绝旧代。 */
  buy(playerId: string, requestId: string, itemId: string,
    generation?: number): PartyBuyResult {
    // 过旧/换代会话的请求先于一切业务检查拒绝。
    const gen = this.checkGeneration(generation);
    if (!gen.ok) return { ok: false, message: gen.message ?? "party 会话身份校验失败" };
    const member = this.findMember(playerId);
    if (!member) return { ok: false, message: `未知玩家 ${playerId}` };
    if (member.host) return { ok: false, message: "host 的钱包由 RunCore 权威持有；影子账本不结算 host 购买" };
    // 游戏环境没有 JS 的 JSON 全局（TSTL 只是把标识符原样保留），
    // 载荷指纹用手工序列化；itemId 是 config.shop 的 id，不含特殊字符。
    const fingerprint = `itemId=${itemId}`;
    const key = txKey(this.generation, this.runId, playerId, requestId);
    // 评审 #6：过 TTL 淘汰的键按"过旧"拒绝——不能淘汰后再扣一次款。
    if (this.expired.has(key)) return { ok: false, message: "请求过旧（去重记录已过期），拒绝重做" };
    const dup = this.dedupe.get(key);
    if (dup) {
      if (dup.fingerprint === fingerprint) {
        return { ...dup.result, duplicate: true };
      }
      return { ok: false, message: "同 requestId 异载荷，已拒绝" };
    }
    const result = this.buyInner(member, itemId);
    this.dedupe.set(key, { fingerprint, at: clockSeconds(), result });
    // 评审二轮 #4：活动记录窗口同样有界（与墓碑同容量）。
    while (this.dedupe.size > EXPIRED_CAP) {
      for (const k of this.dedupe.keys()) {
        this.dedupe.delete(k);
        this.expired.add(k);
        break;
      }
    }
    return result;
  }

  private buyInner(member: PartyMember, itemId: string): PartyBuyResult {
    const item = this.config.shop.find((i) => i.id === itemId);
    if (!item) return { ok: false, message: "无此商品" };
    if (item.mode === "service") return { ok: false, message: "mock 账本不结算服务类（效果走原生，mock 无原生）" };
    const owned = countOf(member.wallet, itemId);
    if (item.globalLimit !== undefined &&
      purchaseCount(member.wallet, itemId) >= item.globalLimit) {
      return { ok: false, message: `${item.name} 全局限购 ${item.globalLimit} 次已用完` };
    }
    if (owned >= item.cap) return { ok: false, message: `${item.name} 已达持有上限（${item.cap}）` };
    if (member.wallet.pt < item.price) {
      return { ok: false, message: `PT不足（需要 ${item.price}，持有 ${member.wallet.pt}）` };
    }
    const next = item.mode === "fill"
      ? owned + (item.cap - owned)
      : owned + 1;
    member.wallet = {
      pt: member.wallet.pt - item.price,
      bag: replaceOrAdd(member.wallet.bag, itemId, next),
      purchaseLog: member.wallet.purchaseLog.concat([itemId]),
    };
    this.bump();
    return { ok: true, message: `已购买 ${item.name}（-${item.price} PT）`, pt: member.wallet.pt, owned: next };
  }

  /** 玩家个人视图：只含自己的账本（调研文档 §7：p3 视图不含 p2 私有账本）。 */
  viewFor(playerId: string): PartySnapshot | null {
    const self = this.findMember(playerId);
    if (!self) return null;
    return {
      runId: this.runId,
      generation: this.generation,
      revision: this.revision,
      members: this.players
        .filter((p) => p.playerId === playerId)
        .map((p: PartyMember) => ({ ...p, wallet: {
          ...p.wallet,
          bag: p.wallet.bag.map((b: OwnedItem) => ({ ...b })),
          purchaseLog: p.wallet.purchaseLog.slice(),
        } })),
    };
  }

  /** 全量快照（房主/调试视角），深拷贝证明无共享引用。 */
  summary(): PartySnapshot {
    return deepCopy({
      runId: this.runId,
      generation: this.generation,
      revision: this.revision,
      members: this.players.map((p: PartyMember) => ({ ...p, wallet: {
        ...p.wallet,
        bag: p.wallet.bag.map((b: OwnedItem) => ({ ...b })),
        purchaseLog: p.wallet.purchaseLog.slice(),
      } })),
    }) as PartySnapshot;
  }

  /** 会话失效：Reset/重建后旧名册与去重账本全部作废。
   * 评审二轮 #1：代数轮换，旧代命令必须显式携带旧 generation，
   * 服务端按代数拒绝；命令不带 generation 视为过旧拒绝。 */
  reset(): void {
    this.players = [];
    this.dedupe.clear();
    this.expired.clear(); // 评审二轮 #4：reset 清墓碑，旧代键不再占内存
    this.generation++;
    this.bump();
  }

  /** 去重账本过期清理（TTL 外淘汰）。评审 #6：淘汰即拒绝该键的后续
   * 请求——防重放窗口是硬边界，不能"淘汰后按新事务"重扣款。
   * 评审二轮 #4：墓碑集合有界（容量上限，超出先进先出淘汰最旧），
   * 保证清理不会让旧报文被当前代重新接纳（同键过旧拒绝仍成立——
   * 键含 generation，越界淘汰的键要么已过代，要么重放窗口已超出）。 */
  prune(now = clockSeconds()): void {
    for (const [k, rec] of this.dedupe) {
      if (now - rec.at > DEDUPE_TTL_S) {
        this.dedupe.delete(k);
        this.expired.add(k);
      }
    }
    while (this.expired.size > EXPIRED_CAP) {
      // Set 迭代序即插入序：淘汰最先进入的墓碑。
      for (const k of this.expired) { this.expired.delete(k); break; }
    }
  }

  /** 服务端代数校验：命令显式携带的 generation 必须与当前代一致。
   * 缺省（未携带）按过旧拒绝——旧客户端不发身份，宁可拒绝。 */
  checkGeneration(generation: number | undefined): { ok: boolean; message?: string } {
    if (generation === undefined) return { ok: false, message: "party 命令缺少 generation；请先 party state 获取当前会话身份" };
    if (generation !== this.generation) return { ok: false, message: `party 会话已更换（generation ${generation} → ${this.generation}），旧请求拒绝` };
    return { ok: true };
  }

  currentGeneration(): number { return this.generation; }

  private findMember(playerId: string): PartyMember | undefined {
    return this.players.find((p) => p.playerId === playerId);
  }

  private bump(): void { this.revision++; }
}

function countOf(wallet: PlayerWallet, itemId: string): number {
  return wallet.bag.find((i) => i.id === itemId)?.count ?? 0;
}

function purchaseCount(wallet: PlayerWallet, itemId: string): number {
  let n = 0;
  for (const p of wallet.purchaseLog) {
    if (p === itemId) n++;
  }
  return n;
}

function replaceOrAdd(bag: OwnedItem[], itemId: string, count: number): OwnedItem[] {
  const next: OwnedItem[] = bag.map((i: OwnedItem) => ({ ...i }));
  const found = next.find((i) => i.id === itemId);
  if (found) found.count = count;
  else next.push({ id: itemId, count });
  return next;
}
