// Render real Vue templates against game-state fixtures. No game commands are sent.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { createServer } from 'vite';
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';

const root = fileURLToPath(new URL('../', import.meta.url));
const server = await createServer({ root, server: { middlewareMode: true, hmr: false, watch: null }, appType: 'custom' });
let checked = 0;
try {
  const { default: Play } = await server.ssrLoadModule('/src/PlayWorkspace.vue');
  const { default: Entry } = await server.ssrLoadModule('/src/MultiplayerEntry.vue');
  const { default: Balance } = await server.ssrLoadModule('/src/BalancePreview.vue');
  const { default: NativeNotice } = await server.ssrLoadModule('/src/NativeNotice.vue');
  const { default: ReleaseCapabilities } = await server.ssrLoadModule('/src/ReleaseCapabilities.vue');
  const { editorConfig } = await server.ssrLoadModule('/src/editor-model.ts');
  const render = (component, props) => renderToString(createSSRApp(component, props));
  const coverage = await render(ReleaseCapabilities, {});
  assert.match(coverage,/已接入多人波次/);assert.match(coverage,/模拟 Steam 身份/);
  assert.match(coverage,/官方 Steam 账号间联机/);assert.match(coverage,/调参的三／四端实机/);
  assert.doesNotMatch(coverage,/多人不支持|全部验收通过/);checked++;
  const state = {
    sessionStage: 'Selecting', layer: 3, pt: 75, cartsLeft: 2, maxCarts: 3,
    capabilities: { start: false, choose: true, stop: true }, shopAvailable: true, shopBusy: false,
    multiplayerRun: { role: 'guest', live: true, members: [{ id: 'self', self: true, ready: true }] },
    choices: [{ index: 0, mode: 'single', label: '单怪', monsters: ['雌火龙'], hpMul: 1, dmgMul: 1, rewardPt: 40 }],
    shop: { '基础补给': [{ id: 'mega_potion', name: '大回复药', category: '基础补给', owned: 1, cap: 10, price: 5, mode: 'perUnit', canBuy: true }] },
    services: { purchases: ['mega_potion', 'mega_potion'], cartRestoreUsed: false },
  };
  const props = { state, connected: true, busy: false, notice: '' };
  const guest = await render(Play, props);
  assert.match(guest, /等待房主选择下一波/);
  assert.match(guest, /购买 1 件/);
  assert.doesNotMatch(guest, /选择单怪并开始/);
  assert.match(guest, /同步状态不代表玩家已经准备好/);
  checked++;
  const networkState = { ...state, ui: { scene: 'village', sceneToken: 'scene-current', dialogs: [{
    token: 'scene-current:dialog:0', kind: 'network_error', supported: true, buttons: ['close'],
    text: '经过一定时间未进行操作。\n已断开连接。', passive: false,
  }] } };
  const disconnected = await render(NativeNotice, { state: networkState, connected: true, busy: false });
  assert.match(disconnected, /已断开连接/);
  assert.match(disconnected, /重新创建或加入大厅/);
  assert.match(disconnected, /关闭游戏提示/);
  assert.doesNotMatch(disconnected, /<button[^>]*disabled/);
  checked++;
  const offlineNotice = await render(NativeNotice, { state: networkState, connected: false, busy: false });
  assert.match(offlineNotice, /<button[^>]*disabled/);
  const unknownNotice = await render(NativeNotice, { state: { ...networkState, ui: { ...networkState.ui,
    dialogs: [{ ...networkState.ui.dialogs[0], supported: false }] } }, connected: true, busy: false });
  assert.doesNotMatch(unknownNotice, /<button/);
  assert.match(unknownNotice, /在游戏窗口中确认/);
  checked++;

  const host = await render(Play, { ...props, state: { ...state, multiplayerRun: { ...state.multiplayerRun, role: 'host' } } });
  assert.match(host, /选择单怪并开始/);
  assert.match(host, /请先与队友确认购物完毕/);
  checked++;

  const stale = await render(Play, { ...props, connected: false });
  assert.match(stale, /等待同步/);
  assert.match(stale, /<button[^>]*disabled[^>]*>购买 1 件/);
  checked++;

  const loading = await render(Entry, { entry: undefined, connected: true, busy: false });
  assert.match(loading, /正在读取大厅状态/);
  assert.doesNotMatch(loading, /先结束当前局|安全重载|Reset scripts/);
  checked++;

  const live = await render(Entry, { entry: undefined, run: state.multiplayerRun, connected: true, busy: false });
  assert.match(live, /进入当前局/);
  assert.doesNotMatch(live, /四步入场/);
  checked++;

  const finished = await render(Play, { ...props, state: { ...state, sessionStage: 'Finished', capabilities: {}, multiplayerRun: null } });
  assert.match(finished, /本局已结束/);
  assert.match(finished, /大回复药 · 2 次/);
  assert.match(finished, /剩余 PT 不代表累计收益/);
  checked++;

  const ended = { maxCarts:3,clearedWaves:2,earnedPt:160,spentPt:0,balance:310,durationSeconds:60,restored:false,
    ending:{intent:'carts-exhausted',native:{questId:900103,unique:7,status:'failed',deaths:3,observedAt:1}} };
  const cats = await render(Play, { ...props, state:{...state,sessionStage:'Finished',runSummary:ended} });
  assert.match(cats,/猫车次数耗尽（3 \/ 3）/);assert.match(cats,/本机原生结果：失败/);checked++;
  const mismatch = await render(Play, { ...props, state:{...state,sessionStage:'Fault',runSummary:{...ended,
    ending:{...ended.ending,native:{...ended.ending.native,status:'success'}}}} });
  assert.match(mismatch,/本机原生结果：成功/);assert.match(mismatch,/不能作为三猫失败验收/);checked++;

  const cfg = editorConfig(JSON.parse(readFileSync(new URL('../../data/rogue_config.json', import.meta.url), 'utf8')));
  const balance = await render(Balance, { draft: cfg, baseline: cfg, layer: 5, players: 2, unlocked: false });
  assert.match(balance, /value="5"/);
  assert.match(balance, /层段边界对照 · 2 人/);
  assert.doesNotMatch(balance, /当前实机仅支持单人/);
  checked++;
  const shorterBaseline = structuredClone(cfg);
  shorterBaseline.pools = [{ ...shorterBaseline.pools[0], from: 1, to: 1 }];
  const extended = await render(Balance, { draft: cfg, baseline: shorterBaseline, layer: 5, players: 1, unlocked: false });
  assert.match(extended, /原方案在该条件下无可用示例/);
  assert.doesNotMatch(extended, /草稿暂不能预览/);
  assert.match(extended, /class="preview-choice"/);
  checked++;
  console.log(`Vue component rendering: ${checked} scenarios passed.`);
} finally {
  await server.close();
}
