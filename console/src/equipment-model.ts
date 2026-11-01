import type { RogueConfig } from './editor-model';

/** Rename an option and its backing equipment definition as a single change. */
export function renameArmor(config: RogueConfig, index: number, proposed: string): string | null {
  const name = proposed.trim(), old = config.armorOptions[index];
  if (!old || !name) return '方案名称不能为空';
  if (name !== old && config.armorOptions.includes(name)) return '方案名称不能重复';
  if (name !== old && config.armorSets?.[name]) return '这个名称已经用于其他套装定义';
  if (config.armorSets?.[old] && name !== old) {
    config.armorSets[name] = config.armorSets[old];
    delete config.armorSets[old];
  }
  config.armorOptions[index] = name;
  return null;
}

export function emptyWeightedPools(config: RogueConfig): string[] {
  return Object.entries(config.gachaPools ?? {}).filter(([, pool]) => !pool.entries.some(entry => entry.w > 0)).map(([id]) => id);
}
