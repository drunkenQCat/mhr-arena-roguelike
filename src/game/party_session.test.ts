import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("./sdk", () => ({ clockSeconds: () => 0 }));
import { validateConfig } from "../core/config";
import { readFileSync } from "node:fs";
import { PartySession } from "./party_session";

function makeParty(mockCount = 1): PartySession {
  const config = validateConfig(JSON.parse(readFileSync(new URL("../../data/rogue_config.json", import.meta.url), "utf8")));
  const party = new PartySession(config, { layer: () => 1 }, "test-run-1");
  const created = party.create("host", mockCount);
  expect(created.ok).toBe(true);
  return party;
}

beforeEach(() => {});

describe("PartySession（离线队友最小切片）", () => {
  it("开局锁定名册：host + mock，人数进 roster；重复 create 拒绝", () => {
    const party = makeParty(2);
    expect(party.rosterSize()).toBe(3);
    expect(party.memberIds()).toEqual(["host", "p2", "p3"]);
    const again = party.create("host", 1);
    expect(again.ok).toBe(false);
  });

  it("mock 人数非法（0 或 4+）拒绝", () => {
    const config = validateConfig(JSON.parse(readFileSync(new URL("../../data/rogue_config.json", import.meta.url), "utf8")));
    const party = new PartySession(config, { layer: () => 1 }, "r");
    expect(party.create("host", 0).ok).toBe(false);
    expect(party.create("host", 4).ok).toBe(false);
  });

  it("p2 虚拟购买只动 p2 账本：host 视图不含 p2 私有账本", () => {
    const party = makeParty(1);
    const r = party.buy("p2", "req-1", "potion", party.summary().generation);
    expect(r.ok).toBe(true);
    expect(r.pt).toBe(140); // 150 - 10
    const p2view = party.viewFor("p2")!;
    expect(p2view.members[0]!.wallet.bag).toEqual([{ id: "potion", count: 1 }]);
    expect(p2view.members).toHaveLength(1); // 只见自己
    // host 视图不含 p2 账本明细（名册可见，钱包不外泄）
    const hostView = party.summary();
    expect(hostView.members.find((m) => m.playerId === "host")!.wallet.bag).toEqual([]);
  });

  it("同一 requestId 重复提交只结算一次（同载荷返回旧结果）", () => {
    const party = makeParty(1);
    const first = party.buy("p2", "req-dup", "potion", party.summary().generation);
    const again = party.buy("p2", "req-dup", "potion", party.summary().generation);
    expect(first.duplicate).toBeUndefined();
    expect(again.duplicate).toBe(true);
    expect(again.pt).toBe(first.pt);
    expect(party.viewFor("p2")!.members[0]!.wallet.bag).toEqual([{ id: "potion", count: 1 }]);
  });

  it("同 requestId 异载荷拒绝", () => {
    const party = makeParty(1);
    party.buy("p2", "req-x", "potion", party.summary().generation);
    const r = party.buy("p2", "req-x", "mega_potion", party.summary().generation);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("同 requestId 异载荷");
  });

  it("快照是深拷贝：改快照不影响权威状态", () => {
    const party = makeParty(1);
    party.buy("p2", "req-1", "potion", party.summary().generation);
    const snap = party.summary();
    const p2snap = snap.members.find((m) => m.playerId === "p2")!;
    p2snap.wallet.bag[0]!.count = 999;
    p2snap.wallet.pt = 0;
    const fresh = party.viewFor("p2")!;
    expect(fresh.members[0]!.wallet.pt).toBe(140);
  });

  it("reset 使名册与去重账本失效", () => {
    const party = makeParty(1);
    party.buy("p2", "req-1", "potion", party.summary().generation);
    party.reset();
    expect(party.rosterSize()).toBeNull();
    const r = party.buy("p2", "req-1", "potion", party.summary().generation);
    expect(r.ok).toBe(false); // 未知玩家（名册已失效）
  });

  it("mock 购买遵守限购与 PT（fill 与 cap）", () => {
    const party = makeParty(1);
    for (let i = 0; i < 15; i++) party.buy("p2", `req-${i}`, "potion", party.summary().generation);
    const view = party.viewFor("p2")!;
    expect(view.members[0]!.wallet.bag.find((b) => b.id === "potion")!.count).toBe(10); // cap 10
    const broke = party.buy("p2", "req-final", "ancient", party.summary().generation);
    expect(broke.ok).toBe(false); // PT 已耗尽
  });

  // ---------- 2026-10-31 评审 7 条的针对性回归 ----------

  it("评审二轮#1: 旧代命令（缺 generation / 携带旧 generation）一律拒绝", () => {
    const party = makeParty(1);
    expect(party.buy("p2", "old-id", "potion", party.summary().generation).ok).toBe(true);
    party.reset();
    party.create("host", 1);
    // 不带 generation 的旧客户端：拒绝（评审二轮 #1 的核心要求）。
    const noGen = party.buy("p2", "old-id", "potion");
    expect(noGen.ok).toBe(false);
    expect(noGen.message).toContain("generation");
    // 显式携带旧代：拒绝。
    const staleGen = party.buy("p2", "old-id", "potion", 1);
    expect(staleGen.ok).toBe(false);
    expect(staleGen.message).toContain("已更换");
    // 携带当前代：正常新事务。
    const currentGen = party.buy("p2", "old-id", "potion", party.summary().generation);
    expect(currentGen.ok).toBe(true);
    expect(currentGen.pt).toBe(140); // 新代新账本 150-10，不是旧代 -20
  });

  it("评审二轮#1: checkGeneration 缺省拒绝、当前代通过", () => {
    const party = makeParty(1);
    expect(party.checkGeneration(undefined).ok).toBe(false);
    expect(party.checkGeneration(party.summary().generation).ok).toBe(true);
    expect(party.checkGeneration(999).ok).toBe(false);
  });

  it("评审#4: host 虚拟购买被拒绝（钱包由 RunCore 权威持有）", () => {
    const party = makeParty(1);
    const r = party.buy("host", "host-req", "potion", party.summary().generation);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("RunCore");
  });

  it("评审#5: viewFor 的 purchaseLog 是深拷贝", () => {
    const party = makeParty(1);
    party.buy("p2", "req-1", "potion", party.summary().generation);
    const view = party.viewFor("p2")!;
    view.members[0]!.wallet.purchaseLog.push("污染");
    expect(party.viewFor("p2")!.members[0]!.wallet.purchaseLog).toEqual(["potion"]);
    const snap = party.summary();
    snap.members.find((m) => m.playerId === "p2")!.wallet.purchaseLog.push("污染");
    expect(party.summary().members.find((m) => m.playerId === "p2")!.wallet.purchaseLog).toEqual(["potion"]);
  });

  it("评审#6: prune 秒级 TTL；过期键拒绝重做而不是重新扣款", () => {
    const party = makeParty(1);
    const first = party.buy("p2", "old", "potion", party.summary().generation);
    expect(first.ok).toBe(true);
    party.prune(601); // TTL 600 秒（秒单位），601 秒后过期
    const replay = party.buy("p2", "old", "potion", party.summary().generation);
    expect(replay.ok).toBe(false);
    expect(replay.message).toContain("过旧");
    // 未到 TTL 的记录仍然去重
    expect(party.buy("p2", "fresh", "potion", party.summary().generation).ok).toBe(true);
    party.prune(600);
    expect(party.buy("p2", "fresh", "potion", party.summary().generation).duplicate).toBe(true);
  });

  it("评审#7: globalLimit 计入购买次数，超出拒绝", () => {
    const config = validateConfig(JSON.parse(readFileSync(new URL("../../data/rogue_config.json", import.meta.url), "utf8")));
    config.shop = config.shop.map((i) => i.id === "potion" ? { ...i, globalLimit: 1 } : i);
    const party = new PartySession(config, { layer: () => 1 }, "r");
    party.create("host", 1);
    expect(party.buy("p2", "r1", "potion", party.summary().generation).ok).toBe(true);
    const second = party.buy("p2", "r2", "potion", party.summary().generation);
    expect(second.ok).toBe(false);
    expect(second.message).toContain("全局限购");
  });
});
