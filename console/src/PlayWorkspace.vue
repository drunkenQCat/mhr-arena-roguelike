<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { ConsoleState } from './api';
import { actions, chooseReason, localizeTransaction, modeHints, modeNames, monsterName, nextStep, orderedCategories, percent, stageNames, stat } from './play-model';
const props = defineProps<{ state: ConsoleState | null; connected: boolean; busy: boolean; notice: string; developerMode?: boolean }>();
const emit = defineEmits<{ command: [cmd: string, extra?: Record<string, unknown>]; multiplayer: [] }>();
const armor = ref(''), category = ref(''), search = ref(''), testLayer = ref(1);
const confirmStop = ref(false);
const prepView = ref<'shop' | 'choices'>('shop');
const allowed = computed(() => actions(props.state, props.connected, props.busy));
const prep = computed(() => props.state?.preparation);
const wave = computed(() => props.state?.control?.activeWave);
const buffs = computed(() => props.state?.services?.buffs);
const categories = computed(() => orderedCategories(Object.keys(props.state?.shop ?? {})));
const idle = computed(() => !props.state || ['Idle', 'Finished'].includes(props.state.sessionStage));
const summary = computed(() => props.state?.runSummary ?? props.state?.previousRun);
const lootName = (id: string) => Object.values(props.state?.shop ?? {}).flat().find(x=>x.id===id)?.name ?? id;
const finished = computed(() => props.state?.sessionStage === 'Finished');
const guest = computed(() => props.state?.multiplayerRun?.role === 'guest');
const choiceBlocked = computed(() => chooseReason(props.state, props.connected, props.busy));
const purchaseSummary = computed(() => {
  const items = Object.values(props.state?.shop ?? {}).flat();
  const counts = new Map<string, number>();
  for (const id of props.state?.services?.purchases ?? []) counts.set(id, (counts.get(id) ?? 0) + 1);
  return [...counts].map(([id, count]) => ({ id, count, name: items.find(item => item.id === id)?.name ?? id }));
});
const rewardDifference = (reward: number) => {
  const single = props.state?.choices?.find(choice => choice.mode === 'single');
  if (!single || reward === single.rewardPt) return '';
  const difference = reward - single.rewardPt;
  return `比本轮单怪${difference > 0 ? '多' : '少'} ${Math.abs(difference)} PT`;
};
const preparing = computed(() => props.state?.sessionStage === 'Preparing');
const selecting = computed(() => preparing.value || props.state?.sessionStage === 'Selecting');
const combat = computed(() => props.state?.sessionStage === 'Combat');
const carving = computed(() => props.state?.sessionStage === 'Carve');
const distance = computed(() => prep.value?.players?.find(p => p.id === prep.value?.localPlayerId)?.campDistance ??
  (!props.state?.online ? prep.value?.players?.[0]?.campDistance : null));
const goods = computed(() => Object.values(props.state?.shop ?? {}).flat().filter(item =>
  (category.value === '全部' || item.category === category.value) &&
  `${item.name} ${item.desc ?? ''}`.toLowerCase().includes(search.value.trim().toLowerCase())));
watch(() => props.state?.armorOptions, values => { if (!values?.includes(armor.value)) armor.value = values?.[0] ?? ''; }, { immediate: true });
watch(() => props.state?.control?.testLayers, values => { if (!values?.includes(testLayer.value)) testLayer.value = values?.[0] ?? 1; }, { immediate: true });
watch(() => props.state?.sessionStage, () => { confirmStop.value = false; prepView.value = 'shop'; });
watch(categories, values => { if (category.value !== '全部' && !values.includes(category.value)) category.value = values[0] ?? ''; }, { immediate: true });
const command = (cmd: string, extra?: Record<string, unknown>) => emit('command', cmd, extra);
function start(test = false) {
  if (!armor.value || !(test ? allowed.value.test : allowed.value.start)) return;
  command('startRun', { armor: armor.value, ...(test ? { testLayer: testLayer.value } : {}) });
}
const routeName = (route?: string) => route === 'inPlace' ? '同场续波' : route === 'reentry' ? '每层重进' : '—';
const buyLabel = (mode: string, id: string) => id.startsWith('gacha_') ? '抽取装备' : mode === 'fill' ? '补满' : mode === 'perUnit' ? '购买 1 件' : '购买服务';
const transactionText = computed(() => {
  const t = props.state?.services?.lastTransaction;
  if (!t) return '';
  const message = localizeTransaction(t.message ?? '', Object.values(props.state?.shop ?? {}).flat());
  if (t.status === 'applied') return `最近交易：${message || '购买成功'}；当前余额 ${props.state?.pt ?? '—'} PT`;
  if (t.status === 'uncertain') return `交易结果待核实，请检查背包或装备，不要重复购买。${t.message ?? ''}`;
  return `购买未完成：${t.message ?? '请检查当前条件'}`;
});
</script>

<template>
  <div class="play-workspace">
    <div class="play-sticky">
    <section class="status-strip" aria-label="本局状态">
      <div><small>{{ state?.multiplayerRun?.live ? (guest ? '联机 · 队友' : '联机 · 房主') : '当前状态' }}</small><strong>{{ connected ? (stageNames[state?.sessionStage ?? ''] ?? '等待游戏') : '等待同步' }}</strong></div>
      <div><small>层数</small><strong>{{ state?.layer ?? '—' }}</strong></div>
      <div><small>可用 PT</small><strong class="gold">{{ state?.pt ?? '—' }}</strong></div>
      <div><small>剩余猫车</small><strong>{{ state?.cartsLeft ?? '—' }} / {{ state?.maxCarts ?? '—' }}</strong></div>
    </section>
    <nav v-if="selecting" class="prep-switch" aria-label="整备操作"><button :class="{ selected: prepView === 'shop' }" :aria-pressed="prepView === 'shop'" @click="prepView = 'shop'">补给商店</button><button v-if="!preparing" :class="{ selected: prepView === 'choices' }" :aria-pressed="prepView === 'choices'" @click="prepView = 'choices'">{{ guest ? '查看候选波次' : '选择下一波' }}</button></nav>
    </div>

    <section v-if="finished || (idle && summary)" class="panel run-summary" aria-label="本局结果">
      <p class="eyebrow">本次狩猎记录</p><h2>本局已结束</h2>
      <p v-if="summary">清除 {{ summary.clearedWaves }} 波 · 获得 {{ summary.earnedPt }} PT · 消费 {{ summary.spentPt }} PT · 余款 {{ summary.balance }} PT · 时长 {{ Math.floor(summary.durationSeconds / 60) }} 分 {{ Math.floor(summary.durationSeconds % 60) }} 秒</p>
      <p v-if="summary" class="muted">{{ summary.restored ? '个人装备与背包已恢复，可以直接准备下一局。' : '等待回村恢复个人装备与背包。' }}</p>
      <p v-if="finished">到达第 <strong class="gold">{{ state?.layer }}</strong> 层 · 剩余 <strong class="gold">{{ state?.pt }} PT</strong> · 剩余猫车 {{ state?.cartsLeft }} / {{ state?.maxCarts }}</p>
      <p v-if="finished">{{ state?.cartsLeft === 0 ? '猫车次数已耗尽。' : '本局流程已结束。' }}{{ state?.control?.startup.restorePending ? '请回村等待原装备与背包恢复。' : '可查看下方购买记录，再准备下一局。' }}</p>
      <p v-if="finished && state?.message" class="muted">游戏说明：{{ state.message }}</p>
      <p v-if="state?.ui?.returnFlow" role="status">{{ state.ui.returnFlow.message }}</p>
      <small>显示游戏保留的本局状态；剩余 PT 不代表累计收益。</small>
    </section>

    <section v-if="idle" class="panel stage-panel">
      <p class="eyebrow">开始狩猎</p><h2>准备新的一局</h2>
      <div class="entry-options"><div><h3>与朋友联机</h3><p class="muted">在游戏内进入同一大厅，选择初始套装；个人装备与物资会备份，局末恢复。</p><button :class="{ primary: state?.online }" @click="emit('multiplayer')">前往联机大厅</button></div><div><h3>单人挑战</h3><p class="muted">使用下方开局方案，按本局规则准备装备与物资。</p></div></div>
      <template v-if="!state?.online">
      <p class="guidance">{{ nextStep(state, connected) }}</p>
      <label class="text-field">选择开局防具<select v-model="armor" :disabled="!allowed.start"><option v-for="item in state?.armorOptions ?? []" :key="item">{{ item }}</option></select></label>
      <p class="muted">{{ state?.control?.armorSets[armor]?.desc ? `套装说明：${state.control.armorSets[armor].desc}` : '防具由当前策划配置决定。' }}</p>
      <p v-if="state?.control?.startupRules" class="muted">{{ state.control.startupRules.keepPlayerWeapon ? '保留当前武器' : '使用配置的开局武器' }} · {{ state.control.startupRules.stripTalismans ? '卸下护石' : '保留护石' }} · {{ state.control.startupRules.stripInsect ? '卸下猎虫' : '保留猎虫' }}</p>
      <p v-if="state?.control?.startup.message" class="notice">{{ state.control.startup.message }}</p>
      <button class="primary" :disabled="!allowed.start || !armor" @click="start()">开始单人挑战</button>
      <small v-if="!allowed.start" class="reason">{{ state?.control?.startReason ?? '等待游戏确认可开局状态。' }}</small>
      <details class="advanced"><summary>高级设置 · 下一局路线：{{ routeName(state?.control?.nextRoute) }}</summary>
        <p class="muted">同场续波会留在斗技场；每层重进会重新进入任务。仅在开局前可切换。</p>
        <div class="route-options"><button v-for="route in ['inPlace', 'reentry']" :key="route" :class="{ selected: state?.control?.nextRoute === route }" :disabled="!allowed.route" @click="command('setRoute', { route })">{{ routeName(route) }}</button></div>
      </details>
      </template>
      <p v-else class="notice">已连接在线大厅，请从“联机大厅”入场。单人挑战需要先在游戏内离开在线大厅。</p>
    </section>

    <section v-if="!idle && !selecting" class="panel stage-panel">
      <p class="eyebrow">{{ carving ? '本波完成' : combat ? '正在狩猎' : '本局状态' }}</p>
      <h2>{{ carving ? '返回任务起点' : combat ? '讨伐当前目标' : (stageNames[state?.sessionStage ?? ''] ?? '等待游戏') }}</h2>
      <p class="guidance">{{ nextStep(state, connected) }}</p>
      <div v-if="wave" class="wave-summary"><span class="badge">{{ modeNames[wave.mode ?? ''] ?? wave.label }}</span><strong>{{ wave.monsters.join(' + ') }}</strong><span>{{ carving ? '本波奖励' : '完成奖励' }} <b class="gold">{{ wave.rewardPt }} PT</b></span></div>
      <div v-if="combat" class="targets"><p>目标进度：{{ prep?.resolved ?? 0 }} / {{ prep?.expected ?? 0 }}</p><div v-for="enemy in state?.enemies ?? []" :key="enemy.uid" class="enemy-row"><span>{{ monsterName(enemy.typeId) }}</span><span class="badge">{{ enemy.captured ? '已捕获' : enemy.dead ? '已死亡' : '在场' }}</span></div><small v-if="!state?.enemies?.length">等待目标出现，空场不会自动结算。</small></div>
      <div v-if="carving" class="gather-card"><strong>{{ prep?.gathered ? '已到达起点' : '尚未到达起点' }}</strong><p v-if="distance != null">距离起点 {{ Math.round(distance) }} · 集结范围 {{ stat(prep?.radius) }}</p><p v-else>正在等待玩家位置。</p><p>剥取时间 {{ stat(prep?.carveRemaining) }} 秒 · 集结停留 {{ stat(prep?.dwellRemaining) }} 秒</p></div>
      <div v-if="allowed.retry" class="toolbar"><button @click="command('retryPost')">重试出发</button></div>
      <p v-if="state?.ui?.returnFlow" class="notice" role="status">{{ state.ui.returnFlow.message }}</p>
      <p v-if="state?.sessionStage === 'Fault' && state?.message" class="notice">{{ state.message }}</p>
    </section>

    <section v-if="selecting" class="preparation-guidance" aria-label="整备提示">
      <p class="guidance">{{ nextStep(state, connected) }}</p>
      <template v-if="state?.multiplayerRun?.live">
        <p class="muted">{{ guest ? '购买完成后请告知房主。' : '选定即出战，请先与队友确认购物完毕。' }} 同步状态不代表玩家已经准备好。</p>
        <div class="chips"><span v-for="(member, index) in state.multiplayerRun.members ?? []" :key="member.id" :class="['badge', member.ready ? 'live' : 'pending']">{{ member.self ? '你' : '队员 ' + (index + 1) }} · {{ member.ready ? '同步已确认' : '等待同步' }}</span></div>
      </template>
    </section>
    <section v-if="state?.supplyLoot?.length" class="panel" aria-label="清波补给">
      <h2>本局最近掉落</h2><p v-for="(item,index) in state.supplyLoot" :key="index">{{ lootName(item.itemId) }} × {{ item.actual }}<small v-if="!item.granted">{{ item.reason || '背包已满或无法完整接收，未扣 PT' }}</small></p>
    </section>
    <div v-if="selecting" class="prep-workbench" :data-view="prepView">
      <section class="panel shop-panel"><div class="section-heading"><div><p class="eyebrow">波次间整备</p><h2>购买补给</h2></div><div class="balance">可用 <strong>{{ state?.pt ?? '—' }} PT</strong></div></div>
        <p v-if="!state?.shopAvailable" class="notice">{{ state?.shopReason || '当前无法购买，请等待游戏准备完成。' }}</p><p v-else class="muted">{{ guest ? '按需购买补给，完成后等待房主选波。' : '补给按需购买，准备完毕后选择下一波。' }}</p>
        <div v-if="transactionText" :class="['transaction', { 'transaction-warning': state?.services?.lastTransaction?.status !== 'applied' }]" role="status">{{ transactionText }}</div>
        <p v-if="busy || notice.includes('待核实') || notice.includes('未及时') || notice.includes('已拒绝')" class="notice" role="status">{{ notice }}</p>
        <div class="tabs"><button v-for="tab in ['全部', ...categories]" :key="tab" :class="{ selected: category === tab }" @click="category = tab">{{ tab }}</button></div>
        <label class="text-field">查找商品<input v-model="search" type="search" placeholder="商品名或说明" /></label>
        <div class="table-scroll"><table><thead><tr><th>商品</th><th>持有 / 上限</th><th>价格</th><th>交易</th></tr></thead><tbody><tr v-for="item in goods" :key="item.id"><td><b>{{ item.name }}</b><small v-if="item.desc">{{ item.desc }}</small></td><td>{{ item.mode === 'service' ? '服务' : `${item.owned} / ${item.cap}` }}</td><td class="gold">{{ item.price }} PT</td><td><button :disabled="!allowed.buy || !item.canBuy" @click="command('buy', { itemId: item.id })">{{ buyLabel(item.mode, item.id) }}</button><small v-if="!item.canBuy && state?.shopAvailable">{{ item.reason || '当前不可购买' }}</small></td></tr></tbody></table></div>
        <p class="muted">装备抽取会新增本局临时条目；在原生道具箱或营地帐篷中更换装备，局末回收并恢复原装。</p>
        <p v-if="!goods.length" class="muted">没有符合条件的商品。</p>
      </section>
      <section v-if="!preparing" class="panel choices-panel"><div class="section-heading"><div><p class="eyebrow">{{ guest ? '由房主决定出战' : '准备好即可出战' }}</p><h2>{{ guest ? '本轮候选波次' : '选择下一波' }}</h2></div><span v-if="!guest" class="muted">选定即出战</span></div>
        <p class="muted">生命 / 伤害为相对原生基础值的规则倍率，非最终实机数值；双怪倍率按每只计算。</p>
        <p v-if="choiceBlocked" class="reason" role="status">{{ choiceBlocked }}</p>
        <div v-if="state?.choices?.length" class="choice-grid"><article v-for="choice in state.choices" :key="choice.index" class="subpanel"><span class="badge">{{ modeNames[choice.mode ?? ''] ?? choice.label }}</span><h3>{{ choice.monsters.join(' + ') }}</h3><p>{{ modeHints[choice.mode ?? ''] }}</p><p class="muted">生命约 {{ percent(choice.hpMul) }}% · 伤害约 {{ percent(choice.dmgMul) }}%</p><strong class="gold">{{ choice.rewardPt }} PT</strong><small v-if="choice.mode !== 'single'">{{ rewardDifference(choice.rewardPt) }}</small><button v-if="!guest" class="primary" :disabled="!allowed.choose" @click="command('choose', { index: choice.index })">选择{{ modeNames[choice.mode ?? ''] ?? '此波' }}并开始</button></article></div>
        <p v-else class="muted">{{ guest ? '等待房主同步候选波次。' : '等待生成波次选项。' }}</p>
      </section>
    </div>

    <section v-if="!idle || finished" class="panel compact-panel"><div class="section-heading"><h2>{{ finished ? '本局购买与讨伐' : '本局成长' }}</h2><span class="muted">{{ routeName(state?.route) }} · {{ state?.armor ?? '保留原装备' }}</span></div>
      <p v-if="buffs && !finished">生效增益：攻击 +{{ stat(buffs.active.atk) }} · 防御 +{{ stat(buffs.active.def) }} · 会心 +{{ stat(buffs.critBonus) }}%</p>
      <p v-if="buffs && (buffs.pending.atk || buffs.pending.def || buffs.pending.crit)" class="muted">待应用：攻击 +{{ stat(buffs.pending.atk) }} · 防御 +{{ stat(buffs.pending.def) }} · 会心服务 {{ buffs.pending.crit }} 次</p>
      <p class="muted">猫车恢复：{{ state?.services?.cartRestoreUsed ? '本局已使用' : '本局尚未使用' }}</p>
      <p>终盘讨伐：{{ state?.killedUltimates?.join('、') || '暂无' }}</p>
      <details v-if="purchaseSummary.length"><summary>查看本局购买记录（{{ state?.services?.purchases?.length }} 笔）</summary><ul><li v-for="item in purchaseSummary" :key="item.id">{{ item.name }} · {{ item.count }} 次</li></ul></details>
      <p v-else class="muted">本局尚无购买记录。</p>
      <div v-if="allowed.stop" class="end-controls"><button v-if="!confirmStop" class="danger" @click="confirmStop = true">结束本局</button><template v-else><span>确定结束本局？</span><button class="danger" @click="confirmStop = false; command('stop')">确定结束</button><button @click="confirmStop = false">继续本局</button></template></div>
    </section>

    <details v-if="developerMode" class="panel tools-panel"><summary>测试工具 · 无敌 / 传送 / 快速击杀 / 指定层开局</summary><p class="muted">用于单人测试任务。传送与击杀会等待游戏反馈，期间不能重复提交。</p><div class="toolbar"><button :class="{ selected: state?.invincible }" :aria-pressed="!!state?.invincible" :disabled="!allowed.god" @click="command('setInvincible', { value: !state?.invincible })">无敌：{{ state?.invincible ? '开启' : '关闭' }}</button><button :disabled="!allowed.camp" @click="command('teleport', { to: 'origin' })">回到任务起点</button><button :disabled="!allowed.monster" @click="command('teleport', { to: 'monster' })">前往怪物</button><button class="danger" :disabled="!allowed.kill" @click="command('killAll')">击杀已出场目标</button></div><p class="notice">{{ state?.control?.testMessage || '尚无测试操作结果。' }}</p>
      <label class="text-field">测试起始层<select v-model="testLayer" :disabled="!allowed.test"><option v-for="layer in state?.control?.testLayers ?? []" :key="layer" :value="layer">第 {{ layer }} 层</option></select></label><div class="toolbar"><button :disabled="!allowed.test || !armor" @click="start(true)">使用所选防具从第 {{ testLayer }} 层开局</button></div><small>仅在可正常开局时使用；不补齐前置击杀解锁。</small>
    </details>
    <details class="panel tools-panel"><summary>运行诊断与购买记录</summary><p class="mono">任务 {{ state?.questId ?? '—' }} · 实例 {{ state?.questUnique ?? '—' }} · 波次 {{ prep?.waveToken ?? '—' }}</p><p class="mono">{{ state?.runtimeStatus || '等待状态' }}</p><p class="mono">{{ state?.message || '暂无运行消息' }}</p><p v-for="enemy in state?.enemies ?? []" :key="enemy.uid" class="mono">{{ monsterName(enemy.typeId) }} · UID {{ enemy.uid }}</p><p v-for="player in prep?.players ?? []" :key="player.id" class="mono">玩家 {{ player.id }} · {{ stat(player.position.x) }}, {{ stat(player.position.y) }}, {{ stat(player.position.z) }}</p><p>终盘击杀：{{ state?.killedUltimates?.join('、') || '暂无' }}</p><p class="mono">购买记录：{{ state?.services?.purchases?.join(' · ') || '暂无' }}</p></details>
  </div>
</template>

<style scoped>
.play-workspace{display:grid;grid-template-columns:minmax(0,1fr);gap:16px;margin-top:18px}
.play-sticky{position:sticky;top:0;z-index:5;background:#14110d;padding:6px 0}
.status-strip{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;background:#292117;border:1px solid #766044;border-radius:8px;padding:12px 20px;box-shadow:0 4px 15px #0008}
.status-strip strong{display:block;font-size:19px;color:#f4e5c9}.status-strip strong.gold{color:#f4d18a}
.panel{min-width:0}.stage-panel{padding:26px}.stage-panel h2,.shop-panel h2,.choices-panel h2{font-size:22px}
.stage-panel .text-field{max-width:440px}.stage-panel .primary{min-width:190px}.text-field{margin:14px 0}
.entry-options{display:grid;grid-template-columns:1fr 1fr;gap:20px;border-bottom:1px solid #443728;padding-bottom:18px;margin-bottom:18px}
.entry-options h3{margin-top:0}.entry-options p{margin-bottom:10px}
.reason{display:block;margin:12px 0;color:#e5b89e}.guidance{line-height:1.8;margin:0}.preparation-guidance>.muted{margin:8px 0}
.balance{text-align:right;color:#d0c2a8}.balance strong{display:block;font-size:23px;color:#f4d18a}
.prep-workbench{display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:18px;align-items:start}.prep-switch{display:none}
.shop-panel,.choices-panel{min-width:0}.choices-panel{border-color:#8f7041;background:linear-gradient(150deg,#30271b,#201b15);padding:20px}
.choices-panel .section-heading{gap:6px}.choices-panel .choice-grid{grid-template-columns:1fr;gap:10px}
.choices-panel .subpanel{padding:13px;gap:7px;display:grid;grid-template-columns:1fr auto;align-items:center}
.choices-panel .subpanel h3,.choices-panel .subpanel p,.choices-panel .subpanel small,.choices-panel .subpanel button{grid-column:1/-1}
.choices-panel .subpanel>.gold{grid-column:2;grid-row:1;font-size:19px}.choices-panel .subpanel h3{font-size:15px}
.choices-panel .subpanel p{margin:0;font-size:12px;line-height:1.7}.choices-panel .subpanel button{margin-top:4px;min-height:44px}
.choice-grid .badge{justify-self:start}.shop-panel .tabs{gap:6px;margin:14px 0}.shop-panel .tabs button{padding:7px 10px}
.shop-panel .table-scroll{max-height:480px;overflow:auto;scrollbar-gutter:stable}.shop-panel th{position:sticky;top:0;background:#201b15;z-index:1}
.shop-panel td{padding:12px 7px}.shop-panel td:last-child{min-width:112px}.shop-panel .text-field{max-width:none}
.transaction{font-size:13px;padding:9px 12px;margin:12px 0;color:#d5e9c7;border-left:3px solid #8eb678;background:#263023;line-height:1.6}
.transaction-warning{color:#ffd2be;border-color:#d08062;background:#35231e}
.wave-summary{display:flex;align-items:center;gap:14px;flex-wrap:wrap;background:#191510;border:1px solid #53432d;border-radius:7px;padding:16px;margin:16px 0}
.wave-summary strong{font-size:19px}.targets,.gather-card{max-width:650px;margin-top:20px}
.gather-card{padding:16px;background:#191510;border:1px solid #705c3e;border-radius:7px}.gather-card p{margin:8px 0 0}
.enemy-row{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;padding:12px 0;border-bottom:1px solid #443728}
.end-controls{display:flex;align-items:center;flex-wrap:wrap;gap:10px;margin-top:18px}.tools-panel{padding:16px 20px}
.compact-panel p{margin-bottom:8px}.compact-panel li{margin:8px 0}.toolbar button{max-width:100%;white-space:normal}
.route-options{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:16px 0}.route-options button{text-align:left}
.run-summary{border-color:#b68b42}.run-summary p{line-height:1.8}details.panel>summary{font-size:15px}
@media(max-width:900px){
  .prep-workbench{grid-template-columns:minmax(0,1fr);gap:12px}
  .prep-switch{display:flex;gap:8px;padding-top:8px}.prep-switch button{flex:1;min-height:44px}
  .prep-workbench[data-view="shop"] .choices-panel,.prep-workbench[data-view="choices"] .shop-panel{display:none}
  .shop-panel .table-scroll{max-height:none;overflow:visible}.shop-panel th{position:static}.shop-panel{padding:14px}
}
@media(max-width:600px){
  .status-strip{gap:10px 16px;padding:10px 12px}.status-strip strong{font-size:16px}.status-strip>div:first-child{width:100%}
  .stage-panel{padding:18px}.entry-options{grid-template-columns:1fr}.balance{text-align:left}
  .shop-panel table,.shop-panel tbody{display:block}.shop-panel thead{display:none}
  .shop-panel tbody tr{display:grid;grid-template-columns:1fr auto auto;gap:8px 12px;padding:14px 0;border-bottom:1px solid #443728;align-items:center}
  .shop-panel td{display:block;padding:0;border:0;min-width:0!important}.shop-panel td:first-child{grid-column:1/-1}
  .shop-panel td:nth-child(2)::before{content:'持有 ';color:#b6a995}.shop-panel td:last-child{max-width:150px}
}
@media(max-width:480px){.route-options{grid-template-columns:1fr}}
@media(max-height:500px){.play-sticky{position:static}}
</style>
