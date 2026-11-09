import type { ConsoleState, RunSummary } from './api';
import catalog from '../../data/monster_ids.json';
import itemIds from '../../data/item_ids.json';

export const modeNames: Record<string, string> = { single: '单怪', sequential: '顺序连战', simultaneous: '同时双怪' };
export const modeHints: Record<string, string> = {
  single: '集中讨伐一个目标。',
  sequential: '依次讨伐两只怪物，注意为第二场保留补给。',
  simultaneous: '同时应对两只怪物，需要兼顾走位与控场。',
};
export function chooseReason(s: ConsoleState | null, connected: boolean, busy: boolean): string {
  if (!connected || !s) return '等待游戏状态恢复后再选择。';
  if (s.multiplayerRun?.role === 'guest') return '由房主选择下一波；你可以先购买补给。';
  if (busy || s.shopBusy) return '请等待当前操作确认后再选择。';
  if (!s.capabilities?.choose) return '暂不能出战，请检查集结与队伍同步状态。';
  return '';
}
export function entryGuidance(entry: ConsoleState['multiplayerEntry'], connected: boolean): string {
  if (!connected) return '正在等待游戏连接，请保持游戏开启并进入村庄。';
  if (!entry) return '正在读取大厅状态，请稍候。';
  if (entry.playing) return '当前已进入任务，请到“当前局”查看进度和购买补给。';
  if (!entry.canPrepare) return '等待当前局结算、回村和个人装备、背包恢复；完成后可直接准备新局。';
  if (!entry.sync.available) return entry.sync.reason || 'Steam 同步暂不可用，请检查游戏内的连接状态。';
  if (!entry.sync.lobby) return '在游戏信使处创建或加入同一个在线大厅。';
  if (entry.posting) return '正在确认全队任务表，请等待游戏打开柜台。';
  if (entry.role === 'guest') return '等待房主承接任务，然后从游戏内任务板加入；无需在网页选怪。';
  if (entry.canPost) return '任务已准备好，可以承接联机任务；出发前在游戏内确认参战名单。';
  return '选择入场波次，等待所有队友的任务表一致后承接任务。';
}
export const stageNames: Record<string, string> = { Idle: '未开局', Preparing: '联机开局整备', Selecting: '整备 · 选择波次', AwaitQuest: '等待进入任务', Combat: '战斗中', Carve: '剥取 · 集结', Returning: '返回村庄', Finished: '本局结束', Fault: '需要处理' };
export function runEnding(summary:RunSummary|null|undefined):{title:string;detail:string;warning:string} {
  const end=summary?.ending,native=end?.native;
  const intentNames:Record<string,string>={'cleared-all':'已通关全部层数','carts-exhausted':'猫车次数耗尽',stopped:'主动终止',fault:'因错误停止','native-ended':'原生任务结束','quest-left':'已离开任务','entry-cancelled':'入场已取消'};
  let title=intentNames[end?.intent??'']??'本局已结束';
  let detail='尚未记录本机原生成功或失败结果。';
  let warning='';
  if(native){
    if(native.status==='failed'){
      const exhausted=native.deaths!=null&&summary?.maxCarts!=null&&native.deaths>=summary.maxCarts;
      title=end?.intent==='stopped'?'主动终止':end?.intent==='fault'?'因错误停止':
        exhausted?`猫车次数耗尽（${native.deaths} / ${summary!.maxCarts}）`:'任务失败';
      detail=`本机原生结果：失败；猫车 ${native.deaths??'未知'} 次。`;
    } else if(native.status==='success'){
      title=end?.intent==='cleared-all'?'已通关全部层数':'原生任务完成';
      detail=`本机原生结果：成功；猫车 ${native.deaths??'未知'} 次。`;
      if(['carts-exhausted','stopped','fault'].includes(end?.intent??''))warning='原生成功结果与工具结束原因不一致；本次不能作为三猫失败验收。';
    } else detail='本机已进入返回流程，尚未观察到原生成功或失败结果。';
    if(native.conflictingStatus)warning='同一任务记录了相互冲突的原生结果，请下载日志核查。';
  }
  return {title,detail,warning};
}
const names = new Map(Object.values(catalog).map(m => [m.id, m.cn]));
export const monsterName = (id: number) => names.get(id) ?? `怪物 ${id}`;
export const stat = (n?: number | null) => n == null || !Number.isFinite(n) ? '—' : String(Number(n.toFixed(4)));
export const percent = (n?: number | null) => n == null || !Number.isFinite(n) ? '—' : String(Number((n * 100).toFixed(1)));
export const orderedCategories = (values: string[]) => {
  const order = ['基础补给', '战术道具', '高阶药品', '翻盘服务', '弹药', '调和素材'];
  return [...values].sort((a, b) => {
    const ai = order.indexOf(a), bi = order.indexOf(b);
    return (ai < 0 ? order.length : ai) - (bi < 0 ? order.length : bi) || a.localeCompare(b, 'zh-CN');
  });
};
export function localizeTransaction(message: string, items: { id: string; name: string }[]): string {
  const names = itemIds as Record<string, { name: string }>;
  const translations = items.flatMap(item => names[item.id]?.name ? [{ from: names[item.id]!.name, to: item.name }] : [])
    .sort((a, b) => b.from.length - a.from.length);
  for (const { from, to } of translations) message = message.split(from).join(to);
  return message;
}
export function actions(s: ConsoleState | null, connected: boolean, busy: boolean) {
  const live = connected && !busy, c = s?.capabilities, effect = !!s?.control?.effectPending;
  return {
    start: live && !!c?.start && !s?.control?.startup.restorePending,
    route: live && !!c?.route, choose: live && !!c?.choose && !s?.shopBusy && s?.multiplayerRun?.role !== 'guest',
    retry: live && !!c?.retry, stop: live && !!c?.stop,
    god: live && !!c?.invincible, kill: live && !!c?.kill && !effect,
    camp: live && !!c?.teleport && !effect, monster: live && !!c?.teleportMonster && !effect,
    test: live && !!c?.testLayer && !s?.control?.startup.restorePending,
    buy: live && !!s?.shopAvailable && !s.shopBusy,
  };
}
export function nextStep(s: ConsoleState | null, connected: boolean): string {
  if (!connected) return '等待新鲜的游戏状态；连接恢复后才能操作。';
  if (!s) return '等待游戏。';
  if (['Idle', 'Finished', 'Fault'].includes(s.sessionStage) && s.control?.startup.restorePending)
    return s.control.startup.message || '请回村，等待原装备与背包恢复完成后再开局。';
  switch (s.sessionStage) {
    case 'Preparing': return '已穿戴初始装备并隔离背包，可用初始 PT 购物；全队加入任务后，由房主手动出发。';
    case 'Selecting': if (s.multiplayerRun?.role === 'guest') return '可在本机购买补给，等待房主选择下一波；请留在起点集结。'; return '先购买补给或服务，再选择下一波。选定后自动开始战斗流程。';
    case 'AwaitQuest': return '等待任务接取与出发；失败时查看提示，再使用重试出发。';
    case 'Combat': return '讨伐本波全部目标；两只怪之间的空场不会结算。';
    case 'Carve': {
      const p = s.preparation;
      if (!p?.camp || !p.players?.length) return '本波已完成，请回到任务起点；等待位置确认。';
      if (!p.gathered) return '本波已完成，请回到任务起点集结。';
      if (p.carveRemaining > 0) return `已到达起点，剥取时间还剩 ${Math.ceil(p.carveRemaining)} 秒。`;
      if (p.dwellRemaining > 0) return `已到达起点，请停留 ${Math.ceil(p.dwellRemaining)} 秒。`;
      return '已集结，等待进入下一轮整备。';
    }
    case 'Returning': return '等待原生返回流程完成，保留本局 PT 与进度。';
    case 'Fault': return s.message || '检查运行提示，重试出发或结束本局。';
    default: return s.control?.startReason ?? '选择开局装备与路线，开始新的一局。';
  }
}
