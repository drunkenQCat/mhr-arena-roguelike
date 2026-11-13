<script setup lang="ts">
import { computed, ref } from 'vue';
import { preview, sampleBalance, type RogueConfig } from './editor-model';
import { modeNames, stat } from './play-model';
const props = defineProps<{ draft: RogueConfig; baseline: RogueConfig | null }>();
const layer = defineModel<number>('layer', { required: true });
const players = defineModel<number>('players', { required: true });
const unlocked = defineModel<boolean>('unlocked', { required: true });
const samplingOpen = ref(false);
const sampled = computed(() => {
  if (!samplingOpen.value) return { rows: [], error: '' };
  try { return { rows: sampleBalance(props.draft, layer.value, players.value, unlocked.value), error: '' }; }
  catch (e) { return { rows: [], error: String(e) }; }
});
function tryPreview(config: RogueConfig | null, atLayer: number) {
  try { return { choices: config ? preview(config, atLayer, players.value, unlocked.value) : [], error: '' }; }
  catch (e) { return { choices: [], error: String(e) }; }
}
const checkpoints = computed(() => [...new Set(props.draft.pools.flatMap(pool => [pool.from, pool.to]))].sort((a, b) => a - b).slice(0, 16).map(n => {
  const current = tryPreview(props.draft, n).choices[0], previous = tryPreview(props.baseline, n).choices[0];
  return { layer: n, hp: current?.hpMul, reward: current?.rewardPt, oldHp: previous?.hpMul, oldReward: previous?.rewardPt };
}));
const results = computed(() => {
  const current = tryPreview(props.draft, layer.value), previous = tryPreview(props.baseline, layer.value);
  return { current: current.choices, previous: previous.choices, error: current.error, previousError: previous.error };
});
const singleReward = computed(() => results.value.current.find(choice => choice.mode === 'single')?.rewardPt ?? 0);
</script>
<template>
  <aside class="balance-preview">
    <h3>波次即时预览</h3>
    <div class="preview-controls"><label>层数 <input v-model.number="layer" type="number" min="1" :max="draft.pools.at(-1)?.to" /></label><label>人数 <select v-model.number="players"><option :value="1">1 人</option><option :value="2">2 人</option><option :value="4">4 人（待验收）</option></select></label></div>
    <label class="check"><input v-model="unlocked" type="checkbox" />解锁所有极强怪（仅预览）</label>
    <p class="muted">固定种子，便于比较；怪物结果不是下一波预测。倍率不等于实际血量。</p>
    <p v-if="results.error" class="notice">草稿暂不能预览：{{ results.error }}</p>
    <p v-if="results.previousError && !results.error" class="muted">原方案在该条件下无可用示例，以下展示当前草稿。</p>
    <article v-for="(choice, i) in results.current" :key="choice.index" class="preview-choice">
      <b>{{ choice.label }}</b><span>生命 ×{{ stat(choice.hpMul) }} · 伤害 ×{{ stat(choice.dmgMul) }}</span><strong class="gold">{{ choice.rewardPt }} PT</strong>
      <small v-if="results.previous[i]">原方案：生命 ×{{ stat(results.previous[i].hpMul) }} · 伤害 ×{{ stat(results.previous[i].dmgMul) }} · {{ results.previous[i].rewardPt }} PT</small>
    </article>
    <details><summary>层段边界对照 · {{ players }} 人</summary><p class="muted">按当前人数与解锁条件比较各层段首尾，最多显示 16 个边界。不同层可能抽到不同怪；“—”表示该条件不能生成示例。</p><div class="table-scroll"><table><thead><tr><th>层</th><th>生命倍率 新 / 原</th><th>PT 新 / 原</th></tr></thead><tbody><tr v-for="point in checkpoints" :key="point.layer"><td>{{ point.layer }}</td><td>{{ point.hp == null ? '—' : stat(point.hp) }} / {{ point.oldHp == null ? '—' : stat(point.oldHp) }}</td><td>{{ point.reward ?? '—' }} / {{ point.oldReward ?? '—' }}</td></tr></tbody></table></div></details>
    <details @toggle="samplingOpen = ($event.target as HTMLDetailsElement).open"><summary>随机组合范围 · 24 次抽样</summary>
      <p class="muted">当前层数、人数和解锁条件下，用同一组种子生成 24 轮候选。范围与均值仅供比较，不代表完整分布或实测通关率。</p>
      <p v-if="sampled.error" class="notice">{{ sampled.error }}</p>
      <article v-for="row in sampled.rows" :key="row.mode" class="preview-choice"><b>{{ modeNames[row.mode] ?? row.mode }}</b><span>奖励 {{ row.minPt }}–{{ row.maxPt }} PT · 平均 {{ row.meanPt.toFixed(1) }} PT</span><span>每只生命倍率 {{ stat(row.minHp) }}–{{ stat(row.maxHp) }}</span></article>
    </details>
    <details><summary>补给购买力 · 当前单怪示例</summary>
      <p class="muted">按一次购买价格除以本层单怪示例奖励；不含开局 PT、消费、限购与解锁限制。</p>
      <div v-if="singleReward > 0" class="table-scroll"><table><thead><tr><th>商品</th><th>相当于清波次数</th></tr></thead><tbody><tr v-for="item in draft.shop.filter(item => ['mega_potion', 'cart_restore', 'buff_atk', 'gacha_1'].includes(item.id))" :key="item.id"><td>{{ item.name }}</td><td>{{ (item.price / singleReward).toFixed(1) }}</td></tr></tbody></table></div>
      <p v-else class="muted">当前没有可用的正奖励示例。</p>
    </details>
    <p v-if="players > 1" class="muted">本机双客户端已通过测试，跨电脑官方 Steam 与三／四人实机仍待验收。这里仅预览规则数值。</p>
  </aside>
</template>
<style scoped>
.balance-preview{position:fixed;right:24px;bottom:78px;width:min(420px,calc(100vw - 32px));z-index:21;border:1px solid #705c3e;background:#191510;border-radius:8px;padding:16px;max-height:calc(100dvh - 110px);overflow:auto}.balance-preview h3{margin-top:0}.preview-controls{display:flex;gap:10px}.preview-controls label{display:grid;gap:6px;font-size:12px}.preview-controls input{width:78px}.preview-controls select{min-width:130px}.preview-choice{display:grid;gap:5px;padding:12px 0;border-top:1px solid #4a3e2c;font-size:13px}.preview-choice span{font-size:12px}.balance-preview .check{margin:12px 0}
</style>
