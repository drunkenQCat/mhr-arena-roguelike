import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { enterGame } from '../lib/game-entry.mjs';

const options = { slot: 1, timeout: 20, timeoutS: 1, receiptTimeoutS: 2 };
async function plugin(t, getUi) {
  const commands = [], receipts = [];
  let counter = 0, phase = 0, readsAfterLoad = 0;
  const server = createServer(async (req, res) => {
    const reply = body => { res.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' }); res.end(JSON.stringify(body)); };
    if (req.url === '/api/state') {
      counter++;
      if (phase === 1) readsAfterLoad++;
      const ui = getUi({ phase, counter, readsAfterLoad });
      return reply({ ok: true, bridgeId: 'test-bridge', counter, questUnique: null, configVersion: 0,
        preparation: { waveToken: null, players: [{ id: 0 }] }, ui });
    }
    if (req.url === '/api/results') return reply({ bridgeId: 'test-bridge', history: receipts });
    if (req.url === '/api/command') {
      let text = ''; for await (const chunk of req) text += chunk;
      const command = JSON.parse(text); commands.push(command);
      receipts.push({ id: command.id, status: 'applied' });
      if (command.cmd === 'save.load') phase = 1;
      if (command.cmd === 'dialog.close') phase = 2;
      return reply({ ok: true, queued: true });
    }
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, commands };
}
const save = { scene: 'save_select', sceneToken: 'save', allowedActions: ['save.load'],
  slots: [{ slot: 1, occupied: true }, { slot: 2, occupied: false }], dialogs: [] };

test('loads once, waits out stale preview and passive loading, closes the village error before success', async t => {
  const p = await plugin(t, ({ phase, readsAfterLoad }) => {
    if (phase === 0) return save;
    if (phase === 2) return { scene: 'village', sceneToken: 'ready', dialogs: [], allowedActions: [] };
    if (readsAfterLoad < 3) return { ...save, scene: 'loading', sceneToken: 'loading',
      dialogs: [{ kind: 'information', passive: true, supported: false }] };
    if (readsAfterLoad < 7) return { ...save, sceneToken: 'stale-preview' };
    return { scene: 'village', sceneToken: 'error', allowedActions: ['dialog.close'],
      dialogs: [{ token: 'error-dialog', supported: true }] };
  });
  const report = await enterGame(p.baseUrl, options, () => {});
  assert.equal(report.scene, 'village');
  assert.deepEqual(p.commands.map(c => c.cmd), ['save.load', 'dialog.close']);
  assert.equal(p.commands[0].slot, 1);
  assert.equal(p.commands[1].dialogToken, 'error-dialog');
  assert.equal(p.commands[0].questUnique, null);
  assert.equal(p.commands[0].waveToken, null);
  assert.ok(p.commands[0].id);
});
test('does not treat an occupied village behind an unknown confirmation as success', async t => {
  const p = await plugin(t, () => ({ scene: 'village', sceneToken: 'blocked',
    dialogs: [{ kind: 'confirmation', supported: false, passive: false }] }));
  await assert.rejects(enterGame(p.baseUrl, options, () => {}), e => e.code === 4);
  assert.equal(p.commands.length, 0);
});
test('refuses empty save slots and never submits a load', async t => {
  const p = await plugin(t, () => save);
  await assert.rejects(enterGame(p.baseUrl, { ...options, slot: 2 }, () => {}), e => e.code === 4);
  assert.equal(p.commands.length, 0);
});
test('times out unknown scenes without generating confirmation input', async t => {
  const p = await plugin(t, () => ({ scene: 'unknown', sceneToken: 'unknown', dialogs: [] }));
  await assert.rejects(enterGame(p.baseUrl, { ...options, timeout: 0.05 }, () => {}), e => e.code === 5);
  assert.equal(p.commands.length, 0);
});
test('requires an explicit slot', async () => {
  await assert.rejects(enterGame('http://127.0.0.1:1', { ...options, slot: undefined }, () => {}), e => e.code === 2);
});
