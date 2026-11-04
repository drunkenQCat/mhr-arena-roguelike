<script setup lang="ts">
import { computed, ref, watch } from "vue";
import NumberField from "./NumberField.vue";
import BalancePreview from "./BalancePreview.vue";
import { renameArmor, emptyWeightedPools } from "./equipment-model";
import { changes, editorConfig, monsters, parameterLabel, poolIssues, preview, validateConfig, type RogueConfig } from "./editor-model";
import { downloadJson } from "./api";

const props = defineProps<{ config: unknown; version: number; serverVersion: number; sessionChanged: boolean; busy: boolean; connected: boolean; message: string }>();
const emit = defineEmits<{ load: []; submit: [config: RogueConfig, version: number] }>();
const draft = ref<RogueConfig | null>(null);
const baseline = ref<RogueConfig | null>(null);
const localMessage = ref("");
const tab = ref("rules");
const search = ref("");
const shopCategory = ref('全部');
const poolIndex = ref(0);
const priceFactor = ref(1);
function scalePrices() { if (!Number.isFinite(priceFactor.value) || priceFactor.value < 0) { localMessage.value = '请输入不小于 0 的调价倍率。'; return; } for (const item of filteredShop.value) item.price = Math.round(item.price * priceFactor.value); }
function splitPool(index: number) { const p = draft.value!.pools[index]; if (p.to <= p.from) return; const middle = Math.floor((p.from + p.to) / 2); const next = JSON.parse(JSON.stringify(p)); next.from = middle + 1; p.to = middle; draft.value!.pools.splice(index + 1, 0, next); poolIndex.value = index + 1; }
function copyPool(index: number) { const pools = draft.value!.pools; const next = JSON.parse(JSON.stringify(pools[index])); const length = next.to - next.from + 1; next.from = pools[pools.length - 1].to + 1; next.to = next.from + length - 1; pools.push(next); poolIndex.value = pools.length - 1; }
const armorName = ref('');
const savedDraft = ref<string | null>(null);
const storageKey = 'mhr-design-draft-v1';
try { savedDraft.value = localStorage.getItem(storageKey); } catch { /* storage unavailable */ }
function storeDraft() {
  if (!draft.value || !baseline.value) return;
  try { localStorage.setItem(storageKey, JSON.stringify({ draft: draft.value, baseline: baseline.value, version: props.version })); savedDraft.value = localStorage.getItem(storageKey); }
  catch { localMessage.value = '浏览器无法保存本地草稿，请导出预设备份。'; }
}
function exportSaved() {
  try { downloadJson('rogue-saved-draft.json', JSON.parse(savedDraft.value ?? '').draft); }
  catch { localMessage.value = '本地草稿无法解析，无法导出。'; }
}
function discardSaved() {
  try { localStorage.removeItem(storageKey); savedDraft.value = null; localMessage.value = '已清除本地备份，当前编辑草稿不受影响。'; }
  catch { localMessage.value = '无法清除本地备份。'; }
}
function restoreSaved() {
  try {
    const saved = JSON.parse(savedDraft.value ?? '');
    if (!baseline.value || JSON.stringify(saved.baseline) !== JSON.stringify(baseline.value) || saved.version !== props.version)
      throw new Error('保存草稿时的游戏配置已变化；请先导出备份并手动合并。');
    draft.value = saved.draft; localMessage.value = '已恢复本地草稿，请检查并提交。';
  } catch (e) { localMessage.value = `无法恢复：${String(e)}`; }
}
watch(draft, () => { if (draft.value && baseline.value && JSON.stringify(draft.value) !== JSON.stringify(baseline.value)) storeDraft(); }, { deep: true });
function renameOption(index: number, event: Event) {
  const input = event.target as HTMLInputElement;
  const issue = renameArmor(draft.value!, index, input.value);
  if (issue) { input.value = draft.value!.armorOptions[index]; localMessage.value = issue; }
}
function addArmor() {
  const name = armorName.value.trim();
  if (!name || draft.value!.armorOptions.includes(name)) { localMessage.value = '请填写未使用的方案名称。'; return; }
  draft.value!.armorSets ??= {};
  draft.value!.armorSets[name] = { series: 0 };
  draft.value!.armorOptions.push(name); armorName.value = '';
}
function removeArmor(index: number) {
  if (draft.value!.armorOptions.length <= 1) return;
  const name = draft.value!.armorOptions[index]; draft.value!.armorOptions.splice(index, 1);
  if (draft.value!.armorSets) delete draft.value!.armorSets[name];
}
function addGacha(pool: string) {
  draft.value!.gachaPools ??= {};
  (draft.value!.gachaPools[pool] ??= { entries: [] }).entries.push({kind: 'weapon', id: 0, w: 1});
}
function removeGacha(pool: string, index: number) {
  const pools = draft.value!.gachaPools!; pools[pool].entries.splice(index, 1);
  if (!pools[pool].entries.length) delete pools[pool];
}

const previewLayer = ref(1);
const players = ref(1);
const unlockAll = ref(false);
const rawText = ref("");
const importFile = ref<HTMLInputElement | null>(null);
const tabs = [ ["rules", "开局与奖励"], ["equipment", "装备与成长"], ["scaling", "难度曲线"], ["pools", "怪物池与解锁"],
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
  try { validateConfig(draft.value); const issues = poolIssues(draft.value); const empty = emptyWeightedPools(draft.value); if (empty.length) issues.push(`抽装池权重不能全为 0：${empty.join('、')}`); return issues.join('；'); }
  catch (e) { return parameterLabel(String(e).replace("Error: ", "").replace("rogue_config 缺失或非法: ", ""))
    .replace(" (gap or overlap)", "：层段必须连续，不能重叠") + "：请检查必填项、数值范围和层段设置"; }
});
const conflict = computed(() => props.version !== props.serverVersion || props.sessionChanged);
const previewResult = computed(() => {
  try { return { choices: draft.value ? preview(draft.value, previewLayer.value, players.value, unlockAll.value) : [], error: "" }; }
  catch (e) { return { choices: [], error: String(e) }; }
});
const filteredMonsters = computed(() => monsters.filter((m) => `${m.name} ${m.en} ${m.id}`.toLowerCase().includes(search.value.toLowerCase())));
const shopCategories = computed(() => ['全部', ...new Set((draft.value?.shop ?? []).map(item => item.category))]);
const filteredShop = computed(() => draft.value?.shop.filter((m) => (shopCategory.value === '全部' || m.category === shopCategory.value) && `${m.name} ${m.id} ${m.category}`.toLowerCase().includes(search.value.toLowerCase())) ?? []);
const scalingFields = [
  { key: "hpBase", label: "首层血量倍率", hint: "相对于原生基础血量" },
  { key: "hpPerLayer", label: "每层血量增量", hint: "线性增长，达到上限后封顶" },
  { key: "hpCap", label: "血量倍率上限" }, { key: "dmgBase", label: "首层伤害倍率" },
  { key: "dmgPerLayer", label: "每层伤害增量" }, { key: "dmgCap", label: "伤害倍率上限" },
  { key: "dualCompensation", label: "双怪每只血量系数", hint: "0.7 = 每只采用单怪血量的 70%，同时影响基础分" },
  { key: "ultimateHpFactor", label: "极强怪血量系数" },
  { key: "mp2Hp", label: "双人血量系数", hint: "按固定联机队伍人数应用；两人实机已验证，三/四人仍待验收" },
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
  poolIndex.value = draft.value!.pools.length;
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
  localMessage.value = "";
  emit("submit", validateConfig(draft.value), props.version);
}
</script>

<template>
  <section class="editor panel">
    <div class="section-heading"><div><p class="eyebrow">DESIGN WORKBENCH</p><h2>策划工作台</h2>
      <p class="muted">编辑草稿并与已载入方案比较。当前战斗和奖励不会中途重算。</p><p class="muted">装备、抽装池、增益数值保存后需在安全回村后 Reset scripts；单人其他设置按各项提示生效。联机配置必须全队一致；修改后全队先回村、保存同一方案，再 Reset scripts 开新局，当前联机局不会热换规则。</p></div>
      <span class="badge">已载入 v{{ version }} · 游戏 v{{ serverVersion }}</span></div>
    <div class="toolbar">
      <button :disabled="busy || !connected || diff.length > 0" @click="emit('load')">载入游戏配置</button>
      <button :disabled="!diff.length || busy" @click="restore">撤销草稿修改</button>
      <button v-if="savedDraft" @click="restoreSaved">恢复本地草稿</button><button v-if="savedDraft" @click="exportSaved">导出本地备份</button><button v-if="savedDraft" @click="discardSaved">清除本地备份</button>
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
      <div class="design-layout"><nav class="design-nav" aria-label="策划编辑分组">
        <button v-for="t in tabs" :key="t[0]" :aria-pressed="tab === t[0]" :class="{ selected: tab === t[0] }" @click="tab = t[0]; search = ''">{{ t[1] }}</button>
      </nav><div class="design-main">
      <div v-if="tab === 'rules'" class="editor-body">
        <h3>开局规则 <span class="badge">下一局生效</span></h3>
        <div class="fields">
          <NumberField v-model="draft.startPt" label="开局 PT" />
          <NumberField v-model="draft.maxCarts" label="猫车总次数" :min="1" />
          <p class="muted">开局点数和猫车次数下一局生效。</p>

        </div>
        <p class="muted">猫车恢复的价格和限购请在“商店定价”修改；旧版开局字段不控制商店交易。</p>
        <h3>基础奖励 <span class="badge">下一次生成选择时生效</span></h3>
        <div class="fields"><NumberField v-for="f in rewardFields" :key="f.key" :model-value="group('reward')[f.key]"
          :label="f.label" @update:model-value="group('reward')[f.key] = $event" /></div>
        <h3>组合奖励倍率</h3>
        <div class="fields"><NumberField v-for="(label, key) in { A: 'A · 单怪', B: 'B · 双弱', C: 'C · 强弱', D: 'D · 双强', AU: 'AU · 极强单怪' }"
          :key="key" :model-value="group('typeRewardMul')[key]" :label="label" :step="0.05" @update:model-value="group('typeRewardMul')[key] = $event" /></div>
        <p class="muted">普通层固定提供 Single / Sequential / Simultaneous；终盘单怪池保持单怪限制。当前选择数：{{ draft.choiceCount }}。</p>
      </div>
      <div v-if="tab === 'equipment'" class="editor-body">
        <h3>开局装备 <span class="badge">保存后重载脚本生效</span></h3>
        <p class="muted">系列号对应游戏内防具系列；请使用已验证的编号。开局前会保存并在结束后恢复原装备。</p>
        <div v-for="(name, i) in draft.armorOptions" :key="i" class="subpanel">
          <div class="fields"><label class="text-field">方案名称<input :value="name" @change="renameOption(i, $event)" /></label>
          <NumberField v-if="draft.armorSets?.[name]" v-model="draft.armorSets[name].series" label="防具系列号" />
          <label v-if="draft.armorSets?.[name]" class="text-field">方案说明<input :value="draft.armorSets[name].desc ?? ''" placeholder="可留空" @change="($event.target as HTMLInputElement).value.trim() ? draft.armorSets![name].desc = ($event.target as HTMLInputElement).value.trim() : delete draft.armorSets![name].desc" /></label></div>
          <p v-if="!draft.armorSets?.[name]" class="notice">此方案没有防具定义，当前会保留已有防具。新增定义后重载生效。</p>
          <button v-if="!draft.armorSets?.[name]" @click="(draft.armorSets ??= {})[name] = {series: 0}">设置防具系列</button>
          <button :disabled="draft.armorOptions.length <= 1" @click="removeArmor(i)">移除此方案</button>
        </div>
        <div class="toolbar"><label>新方案名称 <input v-model="armorName" /></label><button @click="addArmor">添加方案</button></div>
        <div v-if="draft.startupRules" class="subpanel"><h3>开局规则</h3>
          <label class="check"><input v-model="draft.startupRules.keepPlayerWeapon" type="checkbox" />保留当前武器</label>
          <NumberField v-if="!draft.startupRules.keepPlayerWeapon" :model-value="draft.startupRules.weaponId ?? 0" label="指定武器 ID" :min="1" @update:model-value="draft.startupRules!.weaponId = $event" />
          <label class="check"><input v-model="draft.startupRules.stripTalismans" type="checkbox" />卸下护石</label>
          <label class="check"><input v-model="draft.startupRules.stripInsect" type="checkbox" />卸下猎虫</label>
        </div>
        <h3>单波增益 <span class="badge">保存后重载脚本生效</span></h3>
        <div v-if="draft.buffAmounts" class="fields"><NumberField v-model="draft.buffAmounts.atk" label="每次购买攻击增加" /><NumberField v-model="draft.buffAmounts.def" label="每次购买防御增加" /><NumberField v-model="draft.buffAmounts.crit" label="每次购买会心增加（%）" /></div>
        <h3>装备抽取池 <span class="badge">保存后重载脚本生效</span></h3>
        <p class="muted">ID 须是游戏的武器 / 防具 ID；权重决定池内相对概率，并非百分比。未知 ID 未验证能否发放。</p>
        <details v-for="id in ['gacha_1','gacha_2','gacha_3','gacha_4']" :key="id" class="subpanel"><summary>{{ draft.shop.find(item => item.id === id)?.name ?? id }} · {{ draft.gachaPools?.[id]?.entries.length ?? 0 }} 件</summary>
          <div v-for="(entry, index) in draft.gachaPools?.[id]?.entries ?? []" :key="index" class="equipment-entry">
            <label>类型<select v-model="entry.kind"><option value="weapon">武器</option><option value="armor">防具</option></select></label>
            <label>游戏 ID<input v-model.number="entry.id" type="number" min="1" /></label><label>权重<input v-model.number="entry.w" type="number" min="0" step="0.1" /></label>
            <span>{{ ((entry.w / (draft.gachaPools?.[id]?.entries.reduce((a, e) => a + e.w, 0) || 1)) * 100).toFixed(1) }}%</span><button @click="removeGacha(id, index)">移除</button>
          </div><button @click="addGacha(id)">添加装备</button></details>
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
        <div class="toolbar pool-selector"><button v-for="(pool, i) in draft.pools" :key="i" :class="{ selected: poolIndex === i }" @click="poolIndex = i">{{ pool.from }}–{{ pool.to }} 层</button></div>
        <article v-for="(pool, i) in draft.pools" v-show="poolIndex === i" :key="i" class="subpanel">
          <div class="toolbar"><button :disabled="pool.from >= pool.to" @click="splitPool(i)">在中点拆分层段</button><button @click="copyPool(i)">复制为末尾新层段</button><button class="danger" :disabled="draft.pools.length === 1" @click="draft.pools.splice(i, 1); poolIndex = Math.max(0, i - 1)">删除层段</button></div><div class="fields"><NumberField v-model="pool.from" :label="`怪池 ${i + 1} · 起始层`" :min="1" />
            <NumberField v-model="pool.to" label="结束层" :min="pool.from" />
            <label class="text-field">梯度<select v-model="pool.tier"><option value="low">低阶</option><option value="mid">中阶</option><option value="adv">高阶</option><option value="ultimate">极强</option></select></label></div>
          <p class="muted">组合决定怪物类型；出场方式（单怪、顺序、同时）由系统生成。</p><div v-if="pool.tier !== 'ultimate'" class="toolbar"><label v-for="(label, kind) in { A: '单怪', B: '双弱', C: '强弱', D: '双强' }" :key="kind" class="check"><input v-model="pool.types" type="checkbox" :value="kind" />{{ label }}</label>
            </div>
          <p v-if="pool.tier === 'ultimate'" class="notice">极强层只使用极强怪池和单怪选项。</p><div v-for="(label, kind) in { weak: '弱怪池', strong: '强怪池', ultimate: '极强怪池' }" :key="kind" v-show="pool.tier !== 'ultimate' || kind === 'ultimate'" class="monster-group">
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
        <p class="muted">单人价格下次交易生效；联机需全队统一配置并回村重载。猫车恢复价格以本表为准，当前最多恢复一次；限购设 0 可禁用。商品 ID 与交付方式保持已有映射；未接入游戏效果的服务仍不可购买。</p>
        <div class="table-scroll"><table><thead><tr><th>商品</th><th>分类</th><th>价格（PT）</th><th>持有上限</th><th>全局限购</th><th>交付方式</th></tr></thead><tbody>
          <tr v-for="item in filteredShop" :key="item.id"><td>{{ item.name }}<small>{{ item.desc || item.id }}</small><small v-if="previewResult.choices[0]?.rewardPt">约 {{ (item.price / previewResult.choices[0].rewardPt).toFixed(1) }} 次预览单怪奖励</small></td><td>{{ item.category }}</td>
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
      </div><BalancePreview :draft="draft" :baseline="baseline" /></div>
      <details class="advanced"><summary @click="rawText = JSON.stringify(draft, null, 2)">高级：JSON 草稿</summary><textarea v-model="rawText" rows="12" aria-label="高级 JSON 草稿" spellcheck="false" /><button @click="applyRaw">将 JSON 应用到表单草稿</button></details>
      <div class="submit-bar"><span>{{ error ? '请先修正上方配置错误' : '价格下次交易生效；曲线和怪池下次生成生效；装备、抽装池与增益保存后需重载脚本' }}</span>
        <button class="primary" :disabled="!!error || !diff.length || busy || !connected || conflict" @click="submit">{{ busy ? '等待游戏确认…' : '校验并提交到游戏' }}</button></div>
    </template>
  </section>
</template>

<style scoped>
.design-layout{display:grid;grid-template-columns:160px minmax(0,1fr) 320px;gap:18px;align-items:start;margin-top:20px}.design-nav{position:sticky;top:12px;display:grid;gap:7px}.design-nav button{text-align:left}.design-main{min-width:0}.editor-body{min-height:280px}.pool-selector{gap:6px}.equipment-entry{display:grid;grid-template-columns:100px minmax(110px,1fr) 95px 60px auto;gap:8px;align-items:end;margin:12px 0}.equipment-entry label{display:grid;gap:5px;font-size:12px}.equipment-entry input{width:100%}.submit-bar{z-index:6}.design-main .fields{grid-template-columns:repeat(2,minmax(0,1fr))}@media(max-width:1100px){.design-layout{grid-template-columns:140px minmax(0,1fr) 280px}}@media(max-width:950px){.design-layout{grid-template-columns:1fr}.design-nav{position:static;display:flex;flex-wrap:wrap}.design-main .fields{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:600px){.design-main .fields{grid-template-columns:1fr}.equipment-entry{grid-template-columns:1fr 1fr}.equipment-entry button{grid-column:2}.submit-bar{position:static}}
</style>
