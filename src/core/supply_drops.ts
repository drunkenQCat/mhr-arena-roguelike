import type { SupplyDropSpec } from "./config";
export interface SupplyDrop { itemId: string; count: number }
/** Per-monster rolls use the player's RNG, never the host's spending or wallet. */
export function rollSupplyDrops(spec: SupplyDropSpec | undefined, monsters: number,
  roll: (weights: number[]) => number): SupplyDrop[] {
  if (!spec || spec.chance === 0) return [];
  const out: SupplyDrop[] = [];
  for (let i = 0; i < Math.min(2, monsters); i++) {
    if (roll([spec.chance, 1-spec.chance]) !== 0) continue;
    const selected = spec.entries[roll(spec.entries.map(e=>e.weight))];
    if (selected) out.push({itemId:selected.itemId,count:selected.count});
  }
  return out;
}
