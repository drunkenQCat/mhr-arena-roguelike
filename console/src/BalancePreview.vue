<script setup lang="ts">
import { computed, ref } from 'vue';
import { preview, type RogueConfig } from './editor-model';
const props = defineProps<{ draft: RogueConfig; baseline: RogueConfig | null }>();
const layer = ref(1), players = ref(1), unlocked = ref(false);
const checkpoints = computed(() => [1, 5, 10, 15, 20, 30].filter(n => n <= (props.draft.pools.at(-1)?.to ?? 0)).map(n => {
  try { const current = preview(props.draft, n, 1, true)[0]; const previous = props.baseline ? preview(props.baseline, n, 1, true)[0] : undefined;
    return { layer: n, hp: current?.hpMul, reward: current?.rewardPt, oldHp: previous?.hpMul, oldReward: previous?.rewardPt }; }
  catch { return { layer: n, hp: undefined, reward: undefined, oldHp: undefined, oldReward: undefined }; }
}));
const results = computed(() => {
  try { return { current: preview(props.draft, layer.value, players.value, unlocked.value), previous: props.baseline ? preview(props.baseline, layer.value, players.value, unlocked.value) : [], error: '' }; }
  catch (e) { return { current: [], previous: [], error: String(e) }; }
});
</script>
<template>
  <aside class="balance-preview">
    <h3>波次即时预览</h3>
    <div class="preview-controls"><label>层数 <input v-model.number="layer" type="number" min="1" :max="draft.pools.at(-1)?.to" /></label><label>人数 <select v-model.number="players"><option :value="1">1 人</option><option :value="2">2 人（仅数值）</option><option :value="4">4 人（仅数值）</option></select></label></div>
    <label class="check"><input v-model="unlocked" type="checkbox" />解锁所有极强怪（仅预览）</label>
    <p class="muted">固定种子，便于比较；怪物结果不是下一波预测。倍率不等于实际血量。</p>
    <p v-if="results.error" class="notice">草稿暂不能预览：{{ results.error }}</p>
    <article v-for="(choice, i) in results.current" :key="choice.index" class="preview-choice">
      <b>{{ choice.label }}</b><span>生命 ×{{ choice.hpMul }} · 伤害 ×{{ choice.dmgMul }}</span><strong class="gold">{{ choice.rewardPt }} PT</strong>
      <small v-if="results.previous[i]">原方案：生命 ×{{ results.previous[i].hpMul }} · 伤害 ×{{ results.previous[i].dmgMul }} · {{ results.previous[i].rewardPt }} PT</small>
    </article>
    <details><summary>跨层对照（单人单怪示例）</summary><p class="muted">不同层可能抽到不同怪，PT 仅为固定种子的示例。</p><table><thead><tr><th>层</th><th>生命倍率 新 / 原</th><th>PT 新 / 原</th></tr></thead><tbody><tr v-for="point in checkpoints" :key="point.layer"><td>{{ point.layer }}</td><td>{{ point.hp ?? '—' }} / {{ point.oldHp ?? '—' }}</td><td>{{ point.reward ?? '—' }} / {{ point.oldReward ?? '—' }}</td></tr></tbody></table></details>
    <p v-if="players > 1" class="muted">当前实机仅支持单人，多人仅计算数值。</p>
  </aside>
</template>
<style scoped>
.balance-preview{position:sticky;top:12px;border:1px solid #705c3e;background:#191510;border-radius:8px;padding:16px;max-height:calc(100vh - 24px);overflow:auto}.balance-preview h3{margin-top:0}.preview-controls{display:flex;gap:10px}.preview-controls label{display:grid;gap:6px;font-size:12px}.preview-controls input{width:78px}.preview-controls select{min-width:130px}.preview-choice{display:grid;gap:5px;padding:12px 0;border-top:1px solid #4a3e2c;font-size:13px}.preview-choice span{font-size:12px}.balance-preview .check{margin:12px 0}@media(max-width:950px){.balance-preview{position:static;max-height:none}}
</style>
