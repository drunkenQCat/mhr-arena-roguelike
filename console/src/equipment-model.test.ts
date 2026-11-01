import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { editorConfig, validateConfig } from './editor-model';
import { emptyWeightedPools, renameArmor } from './equipment-model';

const config = () => editorConfig(JSON.parse(readFileSync(new URL('../../data/rogue_config.json', import.meta.url), 'utf8')));

it('renames the option and associated armor definition without disturbing the others', () => {
  const c = config(), old = c.armorOptions[0]!, series = c.armorSets![old]!.series;
  expect(renameArmor(c, 0, '测试方案')).toBeNull();
  expect(c.armorOptions[0]).toBe('测试方案');
  expect(c.armorSets!['测试方案']!.series).toBe(series);
  expect(c.armorSets![old]).toBeUndefined();
  expect(() => validateConfig(c)).not.toThrow();
  expect(renameArmor(c, 0, c.armorOptions[1]!)).not.toBeNull();
  expect(c.armorOptions[0]).toBe('测试方案');
});

it('flags pools with no positive weights before submission', () => {
  const c = config();
  c.gachaPools = { gacha_1: { entries: [{ kind: 'weapon', id: 123, w: 0 }] } };
  expect(emptyWeightedPools(c)).toEqual(['gacha_1']);
  c.gachaPools.gacha_1!.entries[0]!.w = 1;
  expect(emptyWeightedPools(c)).toEqual([]);
});
