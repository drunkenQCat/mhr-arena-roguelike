import { captureIdentity, submit, requireReceipt, sleep } from './session.mjs';
import { rejected, usage, timeout } from './exit.mjs';

export async function uiCommand(baseUrl, cmd, options, extra = {}) {
  const identity = await captureIdentity(baseUrl, Math.min(options.timeoutS, 3) * 1000);
  const ui = identity.state.ui;
  if (!ui?.allowedActions?.includes(cmd)) throw rejected(`当前界面不允许 ${cmd}`, { ui });
  const result = await submit(baseUrl, { cmd, sceneToken: ui.sceneToken, ...extra }, {
    identity, timeoutMs: Math.min(options.timeoutS, 3) * 1000, receiptTimeoutMs: options.receiptTimeoutS * 1000,
  });
  requireReceipt(result.receipt);
  return result.receipt;
}

/** Continue only through explicitly observed, supported menus. Never replay a
 * mutation on connection/receipt failure, and never confirm an unknown dialog. */
export async function enterGame(baseUrl, options, progress) {
  if (!Number.isInteger(options.slot) || options.slot < 1 || options.slot > 3)
    throw usage('game enter 必须指定 --slot 1..3（只加载已有存档）');
  const deadline = performance.now() + (options.timeout ?? 120) * 1000;
  let bridge = null, last = null, steps = [], lastActionAt = -Infinity;
  let loadIssued = false;
  let stableToken = null, stableSince = performance.now(), stableCounter = null, observedNewSample = false;
  while (performance.now() < deadline) {
    let identity;
    try { identity = await captureIdentity(baseUrl, Math.min(options.timeoutS * 1000, 3000)); }
    catch (error) {
      if (bridge === null && error.code === 3) { last = { connectionError: error.message }; await sleep(500); continue; }
      throw error;
    }
    if (bridge && bridge !== identity.bridgeId) throw rejected('进入游戏期间 Lua 会话变化', { steps });
    bridge = identity.bridgeId;
    const ui = identity.state.ui;
    last = ui;
    if (stableToken !== ui?.sceneToken) {
      stableToken = ui?.sceneToken; stableSince = performance.now();
      stableCounter = identity.state.counter; observedNewSample = false;
    } else if (stableCounter !== identity.state.counter) observedNewSample = true;
    if (!ui) throw rejected('Lua 没有原生 UI 观察能力，请更新脚本');
    if (['quest', 'quest_ready'].includes(ui.scene)) throw rejected('当前在任务中，拒绝进入存档流程', { ui });
    const dialogs = ui.dialogs ?? [];
    const blocked = dialogs.find(d => d.supported !== true && d.passive !== true);
    if (blocked) throw rejected('遇到未支持的弹窗，停止自动操作', { ui, steps });
    if (ui.scene === 'village' && dialogs.length === 0 && !ui.busy &&
        (identity.state.preparation?.players?.length ?? 0) > 0)
      return { ok: true, scene: ui.scene, requestedSlot: options.slot, steps, state: identity.state };
    if (dialogs.some(d => d.passive === true)) { await sleep(500); continue; }
    let cmd = null, extra = {};
    if (dialogs.length) { cmd = 'dialog.close'; extra.dialogToken = dialogs[0].token; }
    else if (ui.scene === 'autosave_notice') cmd = 'startup.acknowledge';
    else if (ui.scene === 'title_press') cmd = 'title.advance';
    else if (ui.scene === 'title') cmd = 'title.continue';
    else if (ui.scene === 'save_select' && !loadIssued) {
      if (!ui.slots?.some(s => s.slot === options.slot && s.occupied))
        throw rejected('指定槽位未被确认存在，拒绝加载', { slot: options.slot, ui });
      cmd = 'save.load'; extra.slot = options.slot;
    }
    if (cmd && observedNewSample && performance.now() - stableSince >= 1500 && performance.now() - lastActionAt >= 1000) {
      if (steps.length >= 16) throw rejected('菜单操作次数超过限制，可能未正常推进', { steps, ui });
      progress(`${ui.scene}: ${cmd}`);
      const receipt = await uiCommand(baseUrl, cmd, options, extra);
      steps.push({ cmd, receipt });
      if (cmd === "save.load") loadIssued = true;
      lastActionAt = performance.now();
    }
    await sleep(500);
  }
  throw timeout('进入游戏超时', { last, steps });
}
