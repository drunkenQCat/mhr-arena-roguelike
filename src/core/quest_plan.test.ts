import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { makeQuestPlan, normalPatch , ultimateVitalTbl } from "./quest_plan";
import { validateConfig } from "./config";
import { RunCore } from "./run_core";

describe("BOSSRUSH native table plan", () => {
  it("replaces targets/slots together and clears unused template monsters", () => {
    const config = validateConfig(JSON.parse(readFileSync(new URL("../../data/rogue_config.json", import.meta.url), "utf8")));
    const rawCatalog = JSON.parse(readFileSync(new URL("../../data/monster_ids.json", import.meta.url), "utf8"));
    const catalog = { ...rawCatalog };
    for (const [en, v] of Object.entries(rawCatalog)) if (v.cn) catalog[v.cn] = v;
    const core = new RunCore(config, 42);
    core.startRun(config.armorOptions[0]!);
    const wave = core.generateChoices().find((choice) => choice.monsters.length === 2)!;
    const plan = makeQuestPlan(config, catalog, wave, 1, 1, true);
    const patch = normalPatch(plan, 1, 7, 8, 5);
    expect(patch._BossEmType).toEqual([...plan.monsterIds, 0, 0, 0, 0, 0]);
    expect(patch._BossSetCondition).toEqual([1, 7, 0, 0, 0, 0, 0]);
    expect(patch._BossSetParam).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(patch._TgtNum).toEqual([2, 0]);
    expect(patch._TargetType).toEqual([5, 0]);
    expect(patch._QuestType).toBe(8);
    expect(patch._TimeLimit).toBe(0);
    expect(() => makeQuestPlan(config, {}, wave, 1, 2, true)).toThrow("Unknown monster");
  });

  it("records actual HP thresholds rather than treating BOSSRUSH as a sequential flag", () => {
    const reference = JSON.parse(readFileSync(new URL("../../data/bossrush_reference.json", import.meta.url), "utf8"));
    expect(reference.bossrushCount).toBe(14);
    expect(reference.base.normal._BossSetCondition.slice(0, 3)).toEqual([1, 7, 12]);
    expect(reference.base.normal._BossSetParam.slice(0, 3)).toEqual([0, 65, 50]);
  });

  it("resolves every default pool name to a monster with native map-10 evidence", () => {
    const config = JSON.parse(readFileSync(new URL("../../data/rogue_config.json", import.meta.url), "utf8"));
    const ids = JSON.parse(readFileSync(new URL("../../data/monster_ids.json", import.meta.url), "utf8"));
    const reference = JSON.parse(readFileSync(new URL("../../data/bossrush_reference.json", import.meta.url), "utf8"));
    // 刻意先行入池、尚无地图 10 模板证据的怪（research-ultimate-monsters.md §2.2 R1）。
    // 每一项都必须挂着对应的 P2 探针票；探针通过后应从这里移除。
    //   135 冥渊龙：unlockChain 终点（migration.md 的黑龙 Rise 复刻），P2 探针票验证斗技场生成。
    const pendingProbeIds = new Set([135]);
    for (const pool of config.Pools) {
      for (const name of [...pool.Weak, ...(pool.Strong ?? []), ...(pool.Ultimate ?? [])]) {
        const entry = ids[name] ?? Object.values(ids).find((v) => v.cn === name);
        expect(entry, name).toBeDefined();
        if (pendingProbeIds.has(entry.id)) continue;
        expect(reference.arenaMonsterIds, name).toContain(entry.id);
      }
    }
  });
});

it("the selected option's mode overrides the legacy global spawn setting", () => {
 const config = validateConfig(JSON.parse(readFileSync(new URL("../../data/rogue_config.json", import.meta.url), "utf8")));
 const catalog = JSON.parse(readFileSync(new URL("../../data/monster_ids.json", import.meta.url), "utf8"));
 const core = new RunCore(config, 42); core.startRun(config.armorOptions[0]!);
 const choices = core.generateChoices();
 const seq = makeQuestPlan(config, catalog, choices[1]!, 1, 1, false);
 const sim = makeQuestPlan(config, catalog, choices[2]!, 1, 2, true);
 expect(seq.sequential).toBe(true); expect(sim.sequential).toBe(false);
 expect((normalPatch(sim, 1, 7, 8, 5)._BossSetCondition as number[]).slice(0, 2)).toEqual([1, 1]);
});

describe("ultimateVitalTbl（极强单怪难度档重排）", () => {
  const TEMPLATE = [68, 68, 80, 0, 0, 0, 0];
  it("ultimate 单怪：首槽重排为模板最高档 80", () => {
    expect(ultimateVitalTbl(TEMPLATE, "ultimate", 1)).toEqual([80, 68, 68, 0, 0, 0, 0]);
  });
  it("非 ultimate / 多怪 / 首槽已最高档：不改表", () => {
    expect(ultimateVitalTbl(TEMPLATE, "A", 1)).toBeNull();
    expect(ultimateVitalTbl(TEMPLATE, "AU", 2)).toBeNull();
    expect(ultimateVitalTbl([80, 68, 68, 0, 0, 0, 0], "AU", 1)).toBeNull();
    expect(ultimateVitalTbl([], "AU", 1)).toBeNull();
  });
});
