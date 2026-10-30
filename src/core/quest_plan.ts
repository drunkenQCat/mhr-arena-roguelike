import type { RogueConfig } from "./config";
import type { WaveOption } from "./run_state";

export interface RuntimeSettings {
  route: "reentry" | "inPlace";
  spawnMode: "sequential" | "simultaneous";
  autoPost: boolean;
  pollSeconds: number;
  spawnTimeoutSeconds: number;
  carveSeconds: number;
  campRadius: number;
  campDwellSeconds: number;
  postTimeoutSeconds: number;
  /** debug=true 才接受 tp/killAll/setInvincible 等调试命令（release 裁剪埋点与调试面） */
  debugMode: boolean;
}

export const DEFAULT_RUNTIME: RuntimeSettings = {
  route: "inPlace", spawnMode: "sequential", autoPost: true,
  debugMode: false,
  pollSeconds: 1, spawnTimeoutSeconds: 90, carveSeconds: 20,
  campRadius: 15, campDwellSeconds: 2, postTimeoutSeconds: 45,
};

export interface QuestPlan {
  questId: number;
  baseId: number;
  mapNo: number;
  layer: number;
  token: number;
  monsterIds: number[];
  wave: WaveOption;
  sequential: boolean;
}

export type MonsterCatalog = Record<string, { id: number; cn?: string }>;

export function makeQuestPlan(config: RogueConfig, catalog: MonsterCatalog, wave: WaveOption,
  layer: number, token: number, sequential: boolean): QuestPlan {
  if (wave.monsters.length < 1 || wave.monsters.length > 2) throw new Error("M2 supports single/dual monster waves");
  const byCn = new Map(Object.entries(catalog).map(([en, v]) => [v.cn ?? en, v]));
  const monsterIds = wave.monsters.map((name) => {
    const id = (catalog[name] ?? byCn.get(name))?.id;
    if (id === undefined || !Number.isInteger(id) || id <= 0) throw new Error(`Unknown monster: ${name}`);
    return id;
  });
  return { questId: config.quest.id, baseId: config.quest.baseId, mapNo: config.quest.mapNo,
    layer, token, monsterIds, wave, sequential: wave.mode ? wave.mode === "sequential" : sequential };
}

/**
 * V1.3 §2.2 极强单怪难度档重排：把模板 _VitalTbl 首槽换成最高档（模板最高档是
 * 第三槽 80；单怪波只吃第一槽 68 → 实际血量少了最高档）。
 * 仅 tier==="ultimate" 且单怪时重排（返回新数组）；其余返回 null（不改表）。
 * 数组其余元素保持原序，非 boss 槽（0 值）不动。
 */
export function ultimateVitalTbl(template: number[], tier: string, monsterCount: number): number[] | null {
  if (tier !== "ultimate" || monsterCount !== 1) return null;
  if (!Array.isArray(template) || template.length === 0) return null;
  let maxAt = -1;
  let max = -1;
  for (let i = 0; i < template.length; i++) {
    const v = template[i]!;
    if (typeof v === "number" && v > max) { max = v; maxAt = i; }
  }
  if (maxAt <= 0) return null; // 首槽已是最高档，无需重排
  const out = template.slice();
  out[maxAt] = template[0]!;
  out[0] = max;
  return out;
}

/** Native table patch, not a generator. Condition values are supplied from RTTI enums. */
export function normalPatch(plan: QuestPlan, conditionDefault: number, conditionFirstHp: number,
  bossrush: number, allMainEnemy: number): Record<string, unknown> {
  const bosses: number[] = [];
  const conditions: number[] = [];
  const params: number[] = [];
  for (let i = 0; i < 7; i++) {
    bosses.push(plan.monsterIds[i] ?? 0);
    // Production waves have at most two enemies. For later slots use EMn_HP values 7..11.
    conditions.push(i >= plan.monsterIds.length ? 0
      : i === 0 || !plan.sequential ? conditionDefault : conditionFirstHp + i - 1);
    params.push(0);
  }
  return {
    _QuestNo: plan.questId, _MapNo: plan.mapNo, _QuestType: bossrush,
    _DbgName: "MhwRogue_BossRush_v2", _TimeLimit: 0, _QuestLife: 3,
    _QuestLv: 0, _EnemyLv: 0, _IsFromNpc: false,
    _RemMoney: 0, _RemRankPoint: 0, _RemVillagePoint: 0,
    _BossEmType: bosses, _BossSetCondition: conditions, _BossSetParam: params,
    _TargetType: [allMainEnemy, 0], _TgtNum: [plan.monsterIds.length, 0], _TgtEmType: [0, 0],
    _InitExtraEmNum: 0, _SwapEmRate: [0, 0], _SwapSetCondition: [0, 0], _SwapSetParam: [0, 0],
    _OrderType: [0, 0],
  };
}
