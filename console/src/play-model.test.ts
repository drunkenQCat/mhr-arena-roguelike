import { expect, it } from 'vitest';
import { actions, chooseReason, entryGuidance, localizeTransaction, nextStep, monsterName, orderedCategories, percent } from './play-model';
import type { ConsoleState } from './api';
const state = () => ({ sessionStage: 'Selecting', capabilities: { start: true, choose: true, stop: true, route: true, retry: true, invincible: true, kill: true, teleport: true, teleportMonster: true, testLayer: true }, shopAvailable: true, shopBusy: false,
  control: { startup: { restorePending: false }, effectPending: false } }) as ConsoleState;
it('disables every command when stale or a receipt is pending', () => {
  expect(Object.values(actions(state(), false, false)).every(v => !v)).toBe(true);
  expect(Object.values(actions(state(), true, true)).every(v => !v)).toBe(true);
});
it('fails closed for missing game capabilities', () => {
  expect(Object.values(actions(null, true, false)).every(v => !v)).toBe(true);
  expect(actions({ ...state(), capabilities: undefined }, true, false).kill).toBe(false);
});
it('blocks new starts during restoration without blocking valid between-wave shopping', () => {
  const s = state(); s.control!.startup.restorePending = true;
  const a = actions(s, true, false);
  expect(a.start).toBe(false); expect(a.test).toBe(false); expect(a.buy).toBe(true); expect(a.choose).toBe(true);
});
it('blocks repeated effects and purchases while they await confirmation', () => {
  const s = state(); s.control!.effectPending = true; s.shopBusy = true;
  const a = actions(s, true, false);
  expect(a.kill).toBe(false); expect(a.camp).toBe(false); expect(a.monster).toBe(false); expect(a.buy).toBe(false); expect(a.choose).toBe(false);
});
it('shows the actionable recovery/save message while a new run is blocked',()=>{
 const s=state();s.sessionStage='Finished';s.control!.startup.restorePending=true;
 s.control!.startup.message='原装备与背包已恢复；等待原生保存完成';
 expect(nextStep(s,true)).toBe(s.control!.startup.message);
});
it('describes camp gathering and names known enemies without fabricating vitals', () => {
  expect(nextStep({ ...state(), sessionStage: 'Carve' }, true)).toContain('任务起点');
  expect(monsterName(98)).not.toBe('怪物 98'); expect(monsterName(-100)).toBe('怪物 -100');
});
it('keeps common supplies first regardless of server key order and formats multipliers for comparison', () => {
  expect(orderedCategories(['调和素材', '战术道具', '基础补给'])).toEqual(['基础补给', '战术道具', '调和素材']);
  expect(percent(0.4725)).toBe('47.3');
});
it('translates item names in purchase receipts, handling longer names first', () => {
  expect(localizeTransaction('已购买 Mega Potion ×1', [{ id: 'potion', name: '回复药' }, { id: 'mega_potion', name: '大回复药' }])).toBe('已购买 大回复药 ×1');
});
it('explains the unmet regroup condition before countdowns', () => {
  const s = state(); s.sessionStage = 'Carve';
  s.preparation = { camp: { x: 0, y: 0, z: 0 }, players: [{ id: 0, position: { x: 10, y: 0, z: 0 }, campDistance: 10 }], gathered: false, carveRemaining: 0, dwellRemaining: 1, radius: 5, waveToken: 1, seen: 1, resolved: 1, expected: 1 };
  expect(nextStep(s, true)).toContain('回到任务起点');
  s.preparation.gathered = true;
  expect(nextStep(s, true)).toContain('停留 1 秒');
});
it('keeps guest shopping available but blocks departure even if a capability is inconsistent', () => {
  const s = state();
  s.multiplayerRun = { role: 'guest', live: true } as NonNullable<ConsoleState['multiplayerRun']>;
  expect(actions(s, true, false).buy).toBe(true);
  expect(actions(s, true, false).choose).toBe(false);
  expect(chooseReason(s, true, false)).toContain('房主');
  expect(nextStep(s, true)).toContain('等待房主');
  s.multiplayerRun.role = 'host';
  expect(actions(s, true, false).choose).toBe(true);
  expect(chooseReason(s, true, true)).toContain('当前操作');
});
it('does not instruct players to restore or reset scripts while entry data is missing or stale', () => {
  expect(entryGuidance(undefined, true)).toContain('读取');
  expect(entryGuidance(undefined, false)).toContain('连接');
  const entry = { canPrepare: false, playing: false } as NonNullable<ConsoleState['multiplayerEntry']>;
  expect(entryGuidance(entry, false)).not.toContain('回村');
  expect(entryGuidance(entry, true)).toContain('回村');
  entry.playing = true;
  expect(entryGuidance(entry, true)).toContain('当前局');
  expect(entryGuidance(entry, true)).not.toContain('重载');
});
