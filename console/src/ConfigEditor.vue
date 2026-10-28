<script setup lang="ts">
import { computed, ref, watch } from "vue";
import NumberField from "./NumberField.vue";
import { changes, editorConfig, monsters, parameterLabel, poolIssues, preview, validateConfig, type RogueConfig } from "./editor-model";
import { downloadJson } from "./api";

const props = defineProps<{ config: unknown; version: number; serverVersion: number; sessionChanged: boolean; busy: boolean; connected: boolean; message: string }>();
const emit = defineEmits<{ load: []; submit: [config: RogueConfig, version: number] }>();
const draft = ref<RogueConfig | null>(null);
const baseline = ref<RogueConfig | null>(null);
const localMessage = ref("");
const tab = ref("rules");
const search = ref("");
const previewLayer = ref(1);
const players = ref(1);
const unlockAll = ref(false);
const rawText = ref("");
const importFile = ref<HTMLInputElement | null>(null);
const tabs = [ ["rules", "开局与奖励"], ["scaling", "难度曲线"], ["pools", "怪物池与解锁"],
  ["shop", "商店定价"], ["runtime", "流程节奏"], ["review", "预览与提交"] ];
watch(() => props.config, (value) => {
  if (!value) return;
  try {
    if (!draft.value || baseline.value) draft.value = editorConfig(value);
    baseline.value = editorConfig(value); localMessage.value = "";
  }
  catch (error) { localMessage.value = `载入失败：${String(error)}`; }
}, { immediate: true });
const diff = computed(() => baseline.value && draft.value ? changes(baseline.value, draft.value) : []);
const error = computed(() => {
  if (!draft.value) return "尚未载入游戏配置";
  try { validateConfig(draft.value); return poolIssues(draft.value).join("；"); }
  catch (e) { return parameterLabel(String(e).replace("Error: ", "").replace("rogue_config 缺失或非法: ", ""))
    .replace(" (gap or overlap)", "：层段必须连续，不能重叠") + "：请检查必填项、数值范围和层段设置"; }
});
const conflict = computed(() => props.version !== props.serverVersion || props.sessionChanged);
const previewResult = computed(() => {
  try { return { choices: draft.value ? preview(draft.value, previewLayer.value, players.value, unlockAll.value) : [], error: "" }; }
  catch (e) { return { choices: [], error: String(e) }; }
});
const filteredMonsters = computed(() => monsters.filter((m) => `${m.name} ${m.en} ${m.id}`.toLowerCase().includes(search.value.toLowerCase())));
const filteredShop = computed(() => draft.value?.shop.filter((m) => `${m.name} ${m.id} ${m.category}`.includes(search.value)) ?? []);
const scalingFields = [
  { key: "hpBase", label: "首层血量倍率", hint: "相对于原生基础血量" },
  { key: "hpPerLayer", label: "每层血量增量", hint: "线性增长，达到上限后封顶" },
  { key: "hpCap", label: "血量倍率上限" }, { key: "dmgBase", label: "首层伤害倍率" },
  { key: "dmgPerLayer", label: "每层伤害增量" }, { key: "dmgCap", label: "伤害倍率上限" },
  { key: "dualCompensation", label: "双怪每只血量系数", hint: "0.7 = 每只采用单怪血量的 70%，同时影响基础分" },
  { key: "ultimateHpFactor", label: "极强怪血量系数" },
  { key: "mp2Hp", label: "双人血量系数", hint: "仅预览；当前游戏接入仍限单人" },
  { key: "mp34Hp", label: "三/四人血量系数" }, { key: "mp34Dmg", label: "三/四人伤害系数" },
];
const rewardFields = [ { key: "weakBase", label: "弱怪基础 PT" }, { key: "strongBase", label: "强怪基础 PT" },
  { key: "advBase", label: "高阶怪基础 PT" }, { key: "ultimateBase", label: "极强怪基础 PT" } ];
const runtimeFields = [ { key: "pollSeconds", label: "状态采样间隔（秒）", min: 1 },
  { key: "carveSeconds", label: "清波后剥取等待（秒）", min: 0 }, { key: "campRadius", label: "集结半径（游戏单位）", min: 1 },
  { key: "campDwellSeconds", label: "集结停留时间（秒）", min: 0 },
  { key: "spawnTimeoutSeconds", label: "无怪超时与回退（秒）", min: 1 },
  { key: "postTimeoutSeconds", label: "进入任务超时（秒）", min: 1 } ];
function group(name: "scaling" | "reward" | "runtime" | "typeRewardMul" | "simultaneousBalance"): Record<string, number> {
  return draft.value![name] as unknown as Record<string, number>;
}
function addMonster(index: number, kind: "weak" | "strong" | "ultimate", event: Event) {
  const select = event.target as HTMLSelectElement;
  const pool = draft.value!.pools[index]; const list = pool[kind] ?? (pool[kind] = []);
  if (select.value && !list.includes(select.value)) list.push(select.value);
  select.value = "";
}
function addPool() {
  const last = draft.value!.pools.at(-1)?.to ?? 0;
  draft.value!.pools.push({ from: last + 1, to: last + 5, tier: "low", types: ["A", "B"], weak: [], strong: null, ultimate: null });
}
function restore() { if (baseline.value) draft.value = editorConfig(baseline.value); }
async function importPreset(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]; if (!file) return;
  try {
    if (file.size > 262144) throw new Error("预设超过 256 KB");
    draft.value = editorConfig(JSON.parse(await file.text()));
    localMessage.value = "预设已导入草稿，尚未提交到游戏";
  } catch (e) { localMessage.value = `导入失败：${String(e)}`; }
  (event.target as HTMLInputElement).value = "";
}
function applyRaw() {
  try { draft.value = editorConfig(JSON.parse(rawText.value)); localMessage.value = "JSON 已写入草稿，尚未提交"; }
  catch (e) { localMessage.value = `JSON 无效：${String(e)}`; }
}
function submit() {
  if (error.value || !draft.value || conflict.value || props.busy) return;
  emit("submit", validateConfig(draft.value), props.version);
}
</script>

<template>
  <section class="editor panel">
    <div class="section-heading"><div><p class="eyebrow">DESIGN WORKBENCH</p><h2>策划工作台</h2>
      <p class="muted">修改草稿、比较预览，再提交到游戏。当前战斗与奖励不会被中途重算。</p></div>
      <span class="badge">已载入 v{{ version }} · 游戏 v{{ serverVersion }}</span></div>
    <div class="toolbar">
      <button :disabled="busy || !connected || diff.length > 0" @click="emit('load')">载入游戏配置</button>
      <button :disabled="!diff.length || busy" @click="restore">撤销草稿修改</button>
      <button @click="importFile?.click()">导入预设</button>
      <button :disabled="!draft || !!error" @click="downloadJson('rogue-preset.json', draft)">导出预设</button>
      <input ref="importFile" hidden type="file" accept=".json,application/json" aria-label="导入配置预设" @change="importPreset" />
      <span class="muted">{{ diff.length ? `${diff.length} 处待提交修改` : "草稿与已载入配置一致" }}</span>
    </div>
    <p v-if="conflict" class="alert">游戏配置版本已变化。先导出当前草稿，再撤销草稿并重新载入，避免覆盖其他人的修改。</p>
    <p v-if="localMessage || message" class="notice" role="status">{{ localMessage || message }}</p>
    <p v-if="error" class="alert" role="alert">{{ error }}</p>
    <p v-if="!draft" class="empty">连接游戏后载入真实配置。离线也可以导入预设，编辑与预览。</p>
    <template v-if="draft">
      <nav class="tabs" aria-label="策划编辑分组">
        <button v-for="t in tabs" :key="t[0]" :aria-pressed="tab === t[0]" :class="{ selected: tab === t[0] }" @click="tab = t[0]; search = ''">{{ t[1] }}</button>
      </nav>
      <div v-if="tab === 'rules'" class="editor-body">
        <h3>开局规则 <span class="badge">下一局生效</span></h3>
        <div class="fields">
          <NumberField v-model="draft.startPt" label="开局 PT" />
          <NumberField v-model="draft.maxCarts" label="猫车总次数" :min="1" />
          <NumberField v-model="draft.cartRestorePrice" label="猫车恢复价格（PT）" />
          <NumberField v-model="draft.cartRestoreLimit" label="每局猫车恢复限购" />
        </div>
        <label class="text-field">开局方案名称（每行一项；当前仍使用角色已有装备）<textarea :value="draft.armorOptions.join('\n')" rows="3"
          @change="draft.armorOptions = ($event.target as HTMLTextAreaElement).value.split('\n').map(s => s.trim()).filter(Boolean)" /></label>
        <h3>基础奖励 <span class="badge">下一次生成选择时生效</span></h3>
        <div class="fields"><NumberField v-for="f in rewardFields" :key="f.key" :model-value="group('reward')[f.key]"
          :label="f.label" @update:model-value="group('reward')[f.key] = $event" /></div>
        <h3>组合奖励倍率</h3>
        <div class="fields"><NumberField v-for="(label, key) in { A: 'A · 单怪', B: 'B · 双弱', C: 'C · 强弱', D: 'D · 双强', AU: 'AU · 极强单怪' }"
          :key="key" :model-value="group('typeRewardMul')[key]" :label="label" :step="0.05" @update:model-value="group('typeRewardMul')[key] = $event" /></div>
        <p class="muted">普通层固定提供 Single / Sequential / Simultaneous；终盘单怪池保持单怪限制。当前选择数：{{ draft.choiceCount }}。</p>
      </div>
      <div v-if="tab === 'scaling'" class="editor-body">
        <h3>基础曲线 <span class="badge">下一次生成选择时生效</span></h3>
        <div class="fields"><NumberField v-for="f in scalingFields" :key="f.key" :model-value="group('scaling')[f.key]" :label="f.label" :hint="f.hint" :step="0.01" @update:model-value="group('scaling')[f.key] = $event" /></div>
        <h3>同时双怪补偿（相对于同组合 Sequential）</h3>
        <div class="fields"><NumberField :model-value="group('simultaneousBalance').reward" label="奖励倍率" :step="0.05" hint="1.15 = 多给 15% PT" @update:model-value="group('simultaneousBalance').reward = $event" />
          <NumberField :model-value="group('simultaneousBalance').hp" label="每只血量倍率" :step="0.01" hint="0.9 = 血量降低 10%" @update:model-value="group('simultaneousBalance').hp = $event" />
          <NumberField :model-value="group('simultaneousBalance').damage" label="每只伤害倍率" :step="0.01" hint="0.95 = 伤害降低 5%" @update:model-value="group('simultaneousBalance').damage = $event" /></div>
      </div>
      <div v-if="tab === 'pools'" class="editor-body">
        <div class="toolbar"><label>搜索怪物 <input v-model="search" placeholder="中文名 / 英文名 / ID" /></label><button @click="addPool">新增层段</button></div>
        <p class="muted">层段必须从第 1 层开始连续衔接。目录中有 ID 不等于该怪已通过斗技场实测。</p>
        <article v-for="(pool, i) in draft.pools" :key="i" class="subpanel">
          <div class="fields"><NumberField v-model="pool.from" :label="`怪池 ${i + 1} · 起始层`" :min="1" />
            <NumberField v-model="pool.to" label="结束层" :min="pool.from" />
            <label class="text-field">梯度<select v-model="pool.tier"><option value="low">低阶</option><option value="mid">中阶</option><option value="adv">高阶</option><option value="ultimate">极强</option></select></label></div>
          <div class="toolbar"><label v-for="(label, kind) in { A: '单怪', B: '双弱', C: '强弱', D: '双强' }" :key="kind" class="check"><input v-model="pool.types" type="checkbox" :value="kind" />{{ label }}</label>
            <button class="danger" :disabled="draft.pools.length === 1" @click="draft.pools.splice(i, 1)">删除层段</button></div>
          <div v-for="(label, kind) in { weak: '弱怪池', strong: '强怪池', ultimate: '极强怪池' }" :key="kind" class="monster-group">
            <b>{{ label }}</b><div class="chips"><button v-for="(name, n) in pool[kind] ?? []" :key="name" :aria-label="`从${label}移除${name}`" @click="pool[kind]!.splice(n, 1)">{{ name }} ×</button><span v-if="!pool[kind]?.length" class="muted">尚未选择</span></div>
            <select :aria-label="`怪池${i + 1}添加${label}`" @change="addMonster(i, kind, $event)"><option value="">添加怪物…</option><option v-for="m in filteredMonsters" :key="m.id" :value="m.name" :disabled="pool[kind]?.includes(m.name)">{{ m.name }} · {{ m.en }} (#{{ m.id }})</option></select>
          </div>
        </article>
        <h3>极强怪解锁链</h3>
        <div v-for="(rule, i) in draft.unlockChain" :key="i" class="toolbar"><label>击杀<select v-model="rule.requiresKilling"><option v-for="m in monsters" :key="m.id" :value="m.name">{{ m.name }}</option></select></label>
          <label>解锁<select v-model="rule.monster"><option v-for="m in monsters" :key="m.id" :value="m.name">{{ m.name }}</option></select></label><button @click="draft.unlockChain.splice(i, 1)">移除规则</button></div>
        <button @click="draft.unlockChain.push({ monster: '', requiresKilling: '' })">添加解锁规则</button>
      </div>
      <div v-if="tab === 'shop'" class="editor-body">
        <label>查找商品 <input v-model="search" placeholder="名称 / 分类 / 商品 ID" /></label>
        <p class="muted">价格下次交易生效。商品 ID 与交付方式保持已有映射；未接入游戏效果的服务仍不可购买。</p>
        <div class="table-scroll"><table><thead><tr><th>商品</th><th>分类</th><th>价格（PT）</th><th>持有上限</th><th>全局限购</th><th>交付方式</th></tr></thead><tbody>
          <tr v-for="item in filteredShop" :key="item.id"><td>{{ item.name }}<small>{{ item.id }}</small></td><td>{{ item.category }}</td>
            <td><input v-model.number="item.price" type="number" min="0" step="1" :aria-label="`${item.name}价格`" /></td>
            <td><input v-model.number="item.cap" type="number" :min="item.mode === 'service' ? 0 : 1" :aria-label="`${item.name}持有上限`" /></td>
            <td><input :value="item.globalLimit ?? ''" type="number" min="0" placeholder="不限" :aria-label="`${item.name}全局限购`" @input="item.globalLimit = ($event.target as HTMLInputElement).value === '' ? undefined : ($event.target as HTMLInputElement).valueAsNumber" /></td>
            <td>{{ { perUnit: '单件', fill: '补满', service: '服务' }[item.mode] }}</td></tr>
        </tbody></table></div>
      </div>
      <div v-if="tab === 'runtime'" class="editor-body">
        <h3>流程节奏 <span class="badge">下一局生效</span></h3>
        <div class="fields"><NumberField v-for="f in runtimeFields" :key="f.key" :model-value="group('runtime')[f.key]" :label="f.label" :min="f.min" @update:model-value="group('runtime')[f.key] = $event" />
          <label class="text-field">默认路线<select v-model="draft.runtime!.route"><option value="inPlace">inPlace · 同场续波</option><option value="reentry">reentry · 重进任务</option></select></label>
          <label class="check"><input v-model="draft.runtime!.autoPost" type="checkbox" />自动接取任务</label>
        </div>
        <p class="muted">状态时钟目前精度为 1 秒。任务模板只读：#{{ draft.quest.id }} / 模板 {{ draft.quest.baseId }} / 地图 {{ draft.quest.mapNo }}。修改模板需离线部署并重载脚本。</p>
      </div>
      <div v-if="tab === 'review'" class="editor-body">
        <h3>波次预览</h3><p class="muted">直接复用游戏 Core 的生成与计分公式；固定随机种子用于比较草稿，不代表下一次随机结果或原生最终 HP。</p>
        <div class="toolbar"><NumberField v-model="previewLayer" label="预览层数" :min="1" :max="draft.pools.at(-1)?.to" /><label>人数<select v-model.number="players"><option :value="1">1 人 · 当前可用</option><option :value="2">2 人 · 仅数值预览</option><option :value="4">4 人 · 仅数值预览</option></select></label></div>
        <label class="check"><input v-model="unlockAll" type="checkbox" />预览时解锁所有极强怪（仅影响预览）</label>
        <p v-if="previewResult.error" class="alert">{{ previewResult.error }}</p>
        <div class="choice-grid"><article v-for="choice in previewResult.choices" :key="choice.index" class="subpanel"><b>{{ choice.label }}</b><p>HP ×{{ choice.hpMul }} · 伤害 ×{{ choice.dmgMul }}</p><strong class="gold">{{ choice.rewardPt }} PT</strong></article></div>
        <h3>修改清单（{{ diff.length }}）</h3>
        <div class="table-scroll"><table><thead><tr><th>参数</th><th>载入值</th><th>草稿值</th></tr></thead><tbody><tr v-for="change in diff" :key="change.path"><td>{{ parameterLabel(change.path) }}</td><td>{{ JSON.stringify(change.before) ?? '未设置' }}</td><td>{{ JSON.stringify(change.after) ?? '移除' }}</td></tr></tbody></table></div>
        <p v-if="!diff.length" class="muted">还没有修改参数。</p>
      </div>
      <details class="advanced"><summary @click="rawText = JSON.stringify(draft, null, 2)">高级：JSON 草稿</summary><textarea v-model="rawText" rows="12" aria-label="高级 JSON 草稿" spellcheck="false" /><button @click="applyRaw">将 JSON 应用到表单草稿</button></details>
      <div class="submit-bar"><span>{{ error ? '请先修正上方配置错误' : '商店下次交易、曲线与怪池下次生成；开局规则下一局生效' }}</span>
        <button class="primary" :disabled="!!error || !diff.length || busy || !connected || conflict" @click="submit">{{ busy ? '等待游戏确认…' : '校验并提交到游戏' }}</button></div>
    </template>
  </section>
</template>
