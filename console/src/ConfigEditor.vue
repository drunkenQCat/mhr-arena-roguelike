<script setup lang="ts">
import { computed, ref, watch } from "vue";
import gameCatalog from "../../data/game_catalog.json";
import EquipmentCatalog, {type CatalogEntry} from "./EquipmentCatalog.vue";
import DifficultyCurve from "./DifficultyCurve.vue";
import NumberField from "./NumberField.vue";
import BalancePreview from "./BalancePreview.vue";
import { renameArmor, emptyWeightedPools } from "./equipment-model";
import { changes, editorConfig, monsters, parameterLabel, poolIssues, preview, validateConfig, type RogueConfig } from "./editor-model";
import { downloadJson } from "./api";
import EffectDesigner from "./EffectDesigner.vue";
import type {EffectSnapshot} from "./EffectShop.vue";
import {effectProductIssue} from "./effect-model";
import type { EffectDefinition } from "../../src/core/effect_contract";

const props = defineProps<{ config: unknown; version: number; savedVersion?: number | null; serverVersion: number; sessionChanged: boolean; busy: boolean; connected: boolean; message: string;blockedReason?:string;effectDefinitions?:EffectDefinition[];effectSnapshot?:EffectSnapshot|null }>();
const emit = defineEmits<{ load: []; submit: [config: RogueConfig, version: number] }>();
const draft = ref<RogueConfig | null>(null);
const baseline = ref<RogueConfig | null>(null);
const localMessage = ref("");
const tab = ref("rules");
const search = ref("");
const rulesTab = ref("start"), equipmentTab = ref("start"), previewOpen = ref(false);
const fmt = (n: number) => Number(n.toFixed(2));
const shopCategory = ref('全部');
const poolIndex = ref(0);
const priceFactor = ref(1);
function scalePrices() { if (!Number.isFinite(priceFactor.value) || priceFactor.value < 0) { localMessage.value = '请输入不小于 0 的调价倍率。'; return; } for (const item of filteredShop.value) item.price = Math.round(item.price * priceFactor.value); }
function splitPool(index: number) { const p = draft.value!.pools[index]; if (p.to <= p.from) return; const middle = Math.floor((p.from + p.to) / 2); const next = JSON.parse(JSON.stringify(p)); next.from = middle + 1; p.to = middle; draft.value!.pools.splice(index + 1, 0, next); poolIndex.value = index + 1; }
function copyPool(index: number) { const pools = draft.value!.pools; const next = JSON.parse(JSON.stringify(pools[index])); const length = next.to - next.from + 1; next.from = pools[pools.length - 1].to + 1; next.to = next.from + length - 1; pools.push(next); poolIndex.value = pools.length - 1; }
const catalog = ref<CatalogEntry[]>(gameCatalog.entries as CatalogEntry[]), activeGacha=ref('gacha_1');
function addCatalogEntry(entry:CatalogEntry,pool=activeGacha.value){if(!draft.value)return;if(entry.kind==='item'){const id=`native_item_${entry.id}`;if(!draft.value.shop.some(e=>e.id===id))draft.value.shop.push({id,name:entry.name,category:shopCategory.value==='全部'?'基础补给':shopCategory.value,price:10,cap:10,mode:'perUnit',unlockLayer:1});return;}const pools=draft.value.gachaPools??(draft.value.gachaPools={});const entries=(pools[pool]??(pools[pool]={entries:[]})).entries;if(!entries.some(e=>e.kind===entry.kind&&e.id===entry.id))entries.push({kind:entry.kind,id:entry.id,w:1});}
function dropCatalog(event:DragEvent,pool:string){try{const raw=JSON.parse(event.dataTransfer?.getData('application/x-rogue-equipment')??'');const entry=catalog.value.find(e=>e.kind===raw.kind&&e.id===raw.id);if(entry)addCatalogEntry(entry,pool);}catch{localMessage.value='请从游戏装备目录拖入条目';}}
const armorSeries=computed(()=>catalog.value.filter(e=>e.kind==='armor'&&Math.floor((e.id-0x0c000000)/0x100000)===1).map(e=>({series:e.id%0x100000,name:e.name})));
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
const tabs = [ ["rules", "开局与奖励"], ["effects", "商品效果"], ["equipment", "装备与成长"], ["scaling", "难度曲线"], ["pools", "怪物池与解锁"],
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
  try { validateConfig(draft.value); const issues = poolIssues(draft.value); const empty = emptyWeightedPools(draft.value); if (empty.length) issues.push(`抽装池权重不能全为 0：${empty.join('、')}`);
    for(const p of draft.value.effectShop?.products??[]){const reason=effectProductIssue(p,props.effectDefinitions??[],draft.value.effectShop!.groups);if(p.enabled&&reason)issues.push(`${p.name}：${reason}`);}
    return issues.join('；'); }
  catch (e) { return parameterLabel(String(e).replace("Error: ", "").replace("rogue_config 缺失或非法: ", ""))
    .replace(" (gap or overlap)", "：层段必须连续，不能重叠") + "：请检查必填项、数值范围和层段设置"; }
});
const conflict = computed(() => props.version !== props.serverVersion || props.sessionChanged);
const submitState = computed(() => {
  if (props.busy) return { disabled: true, label: '等待游戏确认…', message: '请求处理中，请等待游戏回执。', saved: false };
  if (!props.connected) return { disabled: true, label: '等待连接游戏', message: '游戏连接未就绪；草稿仍保留，连接恢复后可提交。', saved: false };
  if (conflict.value) return { disabled: true, label: '请先核对配置版本', message: '游戏配置或脚本会话已变化；请先导出草稿，再重新载入配置核对。', saved: false };
  if (props.blockedReason) return { disabled: true, label: '当前暂不能提交', message: props.blockedReason, saved: false };
  if (error.value) return { disabled: true, label: '请先修正配置', message: error.value, saved: false };
  if (!diff.value.length) {
    const saved = props.savedVersion != null && props.savedVersion === props.version;
    return { disabled: true, label: saved ? '已保存' : '暂无待提交修改',
      message: saved ? `已保存到游戏 · 配置版本 ${props.version}。暂无待提交修改，可继续编辑。`
        : `与已载入的游戏配置一致 · 配置版本 ${props.version}。修改参数后可提交。`, saved };
  }
  return { disabled: false, label: '校验并提交到游戏', message: `${diff.value.length} 处修改尚未提交 · 当前载入版本 ${props.version}`, saved: false };
});
const previewResult = computed(() => {
  try { return { choices: draft.value ? preview(draft.value, previewLayer.value, players.value, unlockAll.value) : [], error: "" }; }
  catch (e) { return { choices: [], error: String(e) }; }
});
const monsterTier=ref('all');
const monsterGrade=(name:string)=>{const ranks:number[]=[];for(const p of draft.value?.pools??[]){if(p.weak?.includes(name))ranks.push(0);if(p.strong?.includes(name))ranks.push(p.tier==='adv'?2:1);if(p.ultimate?.includes(name))ranks.push(3);}return ranks.length?Math.min(...ranks):4;};
const gradeNames=['弱怪','强怪','高阶怪','极强怪','未分级'];
const filteredMonsters = computed(() => monsters.filter(m=>monsterTier.value==='all'||monsterGrade(m.name)===Number(monsterTier.value)).sort((a,b)=>monsterGrade(a.name)-monsterGrade(b.name)||a.name.localeCompare(b.name,'zh-CN')).filter((m) => `${m.name} ${m.en} ${m.id}`.toLowerCase().includes(search.value.toLowerCase())));
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
  if (error.value || !draft.value || conflict.value || props.busy||props.blockedReason||!props.connected) return;
  localMessage.value = "";
  emit("submit", validateConfig(draft.value), props.version);
}
</script>

<template>
  <section class="editor panel">
    <div class="section-heading"><div><p class="eyebrow">DESIGN WORKBENCH</p><h2>策划工作台</h2>
      <p class="muted">编辑草稿并与已载入方案比较。当前战斗和奖励不会中途重算。</p><p class="muted">联机局内由房主在清波、全员集结和交易完成后提交，全队自动校验并保存后解除屏障。价格用于后续交易；曲线和怪池在下次生成选择时生效；已生成的选项不重算。起始 PT、猫车上限、开局装备、抽装池、增益数值和流程节奏留到下一局。首次准备前，各端仍须使用相同配置。</p></div>
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
      <EffectDesigner v-if="tab === 'effects'" v-model="draft.effectShop" :definitions="effectDefinitions ?? []" :live="effectSnapshot" />
      <div v-if="tab === 'rules'" class="editor-body">
        <nav class="toolbar"><button v-for="t in [['start','开局规则'],['base','基础奖励'],['combo','组合倍率']]" :key="t[0]" :aria-pressed="rulesTab===t[0]" :class="{selected:rulesTab===t[0]}" @click="rulesTab=t[0]">{{ t[1] }}</button></nav><section v-show="rulesTab==='start'"><h3>开局规则 <span class="badge">下一局生效</span></h3>
        <div class="fields">
          <NumberField v-model="draft.startPt" label="开局 PT" />
          <NumberField v-model="draft.maxCarts" label="猫车总次数" :min="1" />
          <p class="muted">开局点数和猫车次数下一局生效。</p>

        </div>
        <p class="muted">猫车恢复的价格和限购请在“商店定价”修改；旧版开局字段不控制商店交易。</p>
        </section><section v-show="rulesTab==='base'"><h3>基础奖励 <span class="badge">下一次生成选择时生效</span></h3>
        <div class="fields"><NumberField v-for="f in rewardFields" :key="f.key" :model-value="group('reward')[f.key]"
          :label="f.label" @update:model-value="group('reward')[f.key] = $event" /></div>
        </section><section v-show="rulesTab==='combo'"><h3>组合奖励倍率</h3>
        <div class="fields"><NumberField v-for="(label, key) in { A: 'A · 单怪', B: 'B · 双弱', C: 'C · 强弱', D: 'D · 双强', AU: 'AU · 极强单怪' }"
          :key="key" :model-value="group('typeRewardMul')[key]" :label="label" :step="0.05" @update:model-value="group('typeRewardMul')[key] = $event" /></div>
        <p class="muted">普通层固定提供 Single / Sequential / Simultaneous；终盘单怪池保持单怪限制。当前选择数：{{ draft.choiceCount }}。</p></section>
      </div>
      <div v-if="tab === 'equipment'" class="editor-body">
        <nav class="toolbar"><button v-for="t in [['start','开局装备'],['drops','清波补给'],['buff','增益'],['gacha','装备抽取池']]" :key="t[0]" :aria-pressed="equipmentTab===t[0]" :class="{selected:equipmentTab===t[0]}" @click="equipmentTab=t[0]">{{ t[1] }}</button></nav><section v-show="equipmentTab==='start'"><h3>开局装备 <span class="badge">下一局生效</span></h3>
        <p class="muted">可按内置游戏中文目录选择套装；以该系列头部名称作为标识。系列号对应游戏内防具系列。提交时会检查当前游戏是否存在全部五个部位；未知系列将拒绝保存。开局前会保存并在结束后恢复原装备。</p>
        <div v-for="(name, i) in draft.armorOptions" :key="i" class="subpanel">
          <div class="fields"><label class="text-field">方案名称<input :value="name" @change="renameOption(i, $event)" /></label>
          <label v-if="draft.armorSets?.[name]" class="text-field">防具套装<select v-model.number="draft.armorSets[name].series"><option v-if="!armorSeries.some(e=>e.series===draft!.armorSets![name].series)" :value="draft.armorSets[name].series">未载入名称（系列 {{ draft.armorSets[name].series }}）</option><option v-for="entry in armorSeries" :key="entry.series" :value="entry.series">{{ entry.name }} · 系列 {{ entry.series }}</option></select></label>
          <label v-if="draft.armorSets?.[name]" class="text-field">方案说明<input :value="draft.armorSets[name].desc ?? ''" placeholder="可留空" @change="($event.target as HTMLInputElement).value.trim() ? draft.armorSets![name].desc = ($event.target as HTMLInputElement).value.trim() : delete draft.armorSets![name].desc" /></label></div>
          <p v-if="!draft.armorSets?.[name]" class="notice">此方案没有防具定义，将拒绝准备。请补齐定义并保存后再开局。</p>
          <button v-if="!draft.armorSets?.[name]" @click="(draft.armorSets ??= {})[name] = {series: 0}">设置防具系列</button>
          <button :disabled="draft.armorOptions.length <= 1" @click="removeArmor(i)">移除此方案</button>
        </div>
        <div class="toolbar"><label>新方案名称 <input v-model="armorName" /></label><button @click="addArmor">添加方案</button></div>
        <div v-if="draft.startupRules" class="subpanel"><h3>开局规则</h3>
          <label class="check"><input v-model="draft.startupRules.keepPlayerWeapon" type="checkbox" />保留当前武器</label>
          <NumberField v-if="!draft.startupRules.keepPlayerWeapon" :model-value="draft.startupRules.weaponId ?? 0" label="指定武器 ID" :min="1" :max="4294967295" @update:model-value="draft.startupRules!.weaponId = $event" />
          <label class="check"><input v-model="draft.startupRules.stripTalismans" type="checkbox" />卸下护石</label>
          <label class="check"><input v-model="draft.startupRules.stripInsect" type="checkbox" />卸下猎虫</label>
        </div>
        </section><section v-show="equipmentTab==='drops'" class="supply-editor"><h3>普通清波补给掉落</h3>
        <p class="muted">每只怪独立判定，每位玩家独立领取。概率为 0 时关闭；物品必须是商店中的真实道具，满袋不会重复发放或扣 PT。</p>
        <button v-if="!draft.supplyDrops" @click="draft.supplyDrops = {chance:0.35,entries:[{itemId:'honey',count:1,weight:1}]}">启用补给掉落</button>
        <template v-if="draft.supplyDrops">
          <NumberField v-model="draft.supplyDrops.chance" label="每只怪掉落概率（0—1）" :step="0.05" />
          <div v-for="(item,index) in draft.supplyDrops.entries" :key="index" class="equipment-entry">
            <label>道具<select v-model="item.itemId"><option v-for="good in draft.shop.filter(x=>x.mode!=='service')" :key="good.id" :value="good.id">{{ good.name }}</option></select></label>
            <NumberField v-model="item.count" label="数量" :min="1" /><NumberField v-model="item.weight" label="权重" :min="0.01" />
            <button :disabled="draft.supplyDrops.entries.length<=1" @click="draft.supplyDrops.entries.splice(index,1)">移除</button>
          </div><button @click="draft.supplyDrops.entries.push({itemId:'honey',count:1,weight:1})">添加掉落道具</button>
        </template>
        </section><section v-show="equipmentTab==='buff'"><h3>单波增益 <span class="badge">下一局生效</span></h3>
        <div v-if="draft.buffAmounts" class="fields"><NumberField v-model="draft.buffAmounts.atk" label="每次购买攻击增加" /><NumberField v-model="draft.buffAmounts.def" label="每次购买防御增加" /><NumberField v-model="draft.buffAmounts.crit" label="每次购买会心增加（%）" /></div>
        </section><section v-show="equipmentTab==='gacha'"><p class="muted">本局珠子是实际装饰品：获得后需在装备箱中镶嵌到兼容槽位才生效，卸下后返回本局库存。</p><h3>装备抽取池 <span class="badge">下一局生效</span></h3>
        <p class="muted">提交时会按当前游戏装备目录检查每个 ID，未知或尚无法读取的装备将拒绝保存。权重决定池内相对概率，并非百分比；目录存在不代表该装备的全部玩法已完成测试。</p>
        <label>当前添加到<select v-model="activeGacha"><option v-for="id in ['gacha_1','gacha_2','gacha_3','gacha_4']" :key="id" :value="id">{{ draft.shop.find(x=>x.id===id)?.name??id }}</option></select></label><div class="pool-workbench"><EquipmentCatalog @loaded="catalog=$event" @add="addCatalogEntry($event)" /><div class="pool-current"><details open v-show="activeGacha===id" @dragover.prevent @drop.prevent="dropCatalog($event,id)" v-for="id in ['gacha_1','gacha_2','gacha_3','gacha_4']" :key="id" class="subpanel"><summary>{{ draft.shop.find(item => item.id === id)?.name ?? id }} · {{ draft.gachaPools?.[id]?.entries.length ?? 0 }} 件</summary>
          <div v-for="(entry, index) in draft.gachaPools?.[id]?.entries ?? []" :key="index" class="equipment-entry">
            <label>类型<select v-model="entry.kind"><option value="weapon">武器</option><option value="armor">防具</option><option value="decoration">装饰品（需镶嵌）</option></select></label>
            <label>装备<select v-model.number="entry.id"><option v-if="!catalog.some(e=>e.kind===entry.kind&&e.id===entry.id)" :value="entry.id">未载入名称 (#{{ entry.id }})</option><option v-for="e in catalog.filter(e=>e.kind===entry.kind)" :key="e.id" :value="e.id">{{ e.name }} (#{{ e.id }})</option></select></label><label>权重<input v-model.number="entry.w" type="number" min="0" step="0.1" /></label>
            <span>{{ ((entry.w / (draft.gachaPools?.[id]?.entries.reduce((a, e) => a + e.w, 0) || 1)) * 100).toFixed(1) }}%</span><button @click="removeGacha(id, index)">移除</button>
          </div><button @click="addGacha(id)">添加装备</button></details></div></div></section>
      </div>
      <div v-if="tab === 'scaling'" class="editor-body scaling-workbench"><DifficultyCurve :config="draft" /><div class="scaling-controls">
        <h3>基础曲线 <span class="badge">下一次生成选择时生效</span></h3>
        <div class="fields"><NumberField v-for="f in scalingFields" :key="f.key" :model-value="group('scaling')[f.key]" :label="f.label" :hint="f.hint" :step="0.01" @update:model-value="group('scaling')[f.key] = $event" /></div>
        <h3>同时双怪补偿（相对于同组合 Sequential）</h3>
        <div class="fields"><NumberField :model-value="group('simultaneousBalance').reward" label="奖励倍率" :step="0.05" hint="1.15 = 多给 15% PT" @update:model-value="group('simultaneousBalance').reward = $event" />
          <NumberField :model-value="group('simultaneousBalance').hp" label="每只血量倍率" :step="0.01" hint="0.9 = 血量降低 10%" @update:model-value="group('simultaneousBalance').hp = $event" />
          <NumberField :model-value="group('simultaneousBalance').damage" label="每只伤害倍率" :step="0.01" hint="0.95 = 伤害降低 5%" @update:model-value="group('simultaneousBalance').damage = $event" /></div>
      </div>
      </div><div v-if="tab === 'pools'" class="editor-body">
        <div class="toolbar"><label>搜索怪物 <input v-model="search" placeholder="中文名 / 英文名 / ID" /></label><button @click="addPool">新增层段</button></div>
        <p class="muted">怪物按当前配置的难度分级排序，未配置的列为未分级。层段必须从第 1 层开始连续衔接。目录中有 ID 不等于该怪已通过斗技场实测。</p>
        <div class="toolbar pool-selector"><button v-for="(pool, i) in draft.pools" :key="i" :class="{ selected: poolIndex === i }" @click="poolIndex = i">{{ pool.from }}–{{ pool.to }} 层</button></div>
        <article v-for="(pool, i) in draft.pools" v-show="poolIndex === i" :key="i" class="subpanel">
          <div class="toolbar"><button :disabled="pool.from >= pool.to" @click="splitPool(i)">在中点拆分层段</button><button @click="copyPool(i)">复制为末尾新层段</button><button class="danger" :disabled="draft.pools.length === 1" @click="draft.pools.splice(i, 1); poolIndex = Math.max(0, i - 1)">删除层段</button></div><div class="fields"><NumberField v-model="pool.from" :label="`怪池 ${i + 1} · 起始层`" :min="1" />
            <NumberField v-model="pool.to" label="结束层" :min="pool.from" />
            <label class="text-field">梯度<select v-model="pool.tier"><option value="low">低阶</option><option value="mid">中阶</option><option value="adv">高阶</option><option value="ultimate">极强</option></select></label></div>
          <p class="muted">组合决定怪物类型；出场方式（单怪、顺序、同时）由系统生成。</p><div v-if="pool.tier !== 'ultimate'" class="toolbar"><label v-for="(label, kind) in { A: '单怪', B: '双弱', C: '强弱', D: '双强' }" :key="kind" class="check"><input v-model="pool.types" type="checkbox" :value="kind" />{{ label }}</label>
            </div>
          <p v-if="pool.tier === 'ultimate'" class="notice">极强层只使用极强怪池和单怪选项。</p><div v-for="(label, kind) in { weak: '弱怪池', strong: '强怪池', ultimate: '极强怪池' }" :key="kind" v-show="pool.tier !== 'ultimate' || kind === 'ultimate'" class="monster-group">
            <b>{{ label }}</b><div class="chips"><button v-for="(name, n) in pool[kind] ?? []" :key="name" :aria-label="`从${label}移除${name}`" @click="pool[kind]!.splice(n, 1)">{{ name }} ×</button><span v-if="!pool[kind]?.length" class="muted">尚未选择</span></div>
            <select :aria-label="`怪池${i + 1}添加${label}`" @change="addMonster(i, kind, $event)"><option value="">添加怪物…</option><option v-for="m in filteredMonsters" :key="m.id" :value="m.name" :disabled="pool[kind]?.includes(m.name)">{{ gradeNames[monsterGrade(m.name)] }} · {{ m.name }} · {{ m.en }} (#{{ m.id }})</option></select>
          </div>
        </article>
        <h3>极强怪解锁链</h3>
        <div v-for="(rule, i) in draft.unlockChain" :key="i" class="toolbar"><label>击杀<select v-model="rule.requiresKilling"><option v-for="m in monsters" :key="m.id" :value="m.name">{{ m.name }}</option></select></label>
          <label>解锁<select v-model="rule.monster"><option v-for="m in monsters" :key="m.id" :value="m.name">{{ m.name }}</option></select></label><button @click="draft.unlockChain.splice(i, 1)">移除规则</button></div>
        <button @click="draft.unlockChain.push({ monster: '', requiresKilling: '' })">添加解锁规则</button>
      </div>
      <div v-if="tab === 'shop'" class="editor-body">
        <details class="subpanel"><summary>从游戏目录添加商品</summary><EquipmentCatalog :kinds="['item']" @loaded="catalog=$event" @add="addCatalogEntry($event)" /><p class="muted">选择道具条目添加真实物品；实际可携带性由游戏校验。不支持携带的物品无法购买。</p></details><nav class="toolbar"><button v-for="category in shopCategories" :key="category" :class="{selected:shopCategory===category}" :aria-pressed="shopCategory===category" @click="shopCategory=category">{{ category }}</button></nav><label>查找商品 <input v-model="search" placeholder="名称 / 分类 / 商品 ID" /></label>
        <p class="muted">单人价格下次交易生效；联机需全队回村并在准备前保存同一配置。猫车恢复价格以本表为准，当前最多恢复一次；限购设 0 可禁用。商品 ID 与交付方式保持已有映射；未接入游戏效果的服务仍不可购买。</p>
        <div class="table-scroll"><table><thead><tr><th>商品</th><th>分类</th><th>价格（PT）</th><th>持有上限</th><th>全局限购</th><th>开放层段</th><th>交付方式</th><th>操作</th></tr></thead><tbody>
          <tr v-for="item in filteredShop" :key="item.id"><td><input v-model="item.name" :aria-label="`${item.id}名称`" /><small>{{ item.desc || item.id }}</small><small v-if="previewResult.choices[0]?.rewardPt">约 {{ (item.price / previewResult.choices[0].rewardPt).toFixed(1) }} 次预览单怪奖励</small></td><td><input v-model="item.category" :aria-label="`${item.name}分类`" /></td>
            <td><input v-model.number="item.price" type="number" min="0" step="1" :aria-label="`${item.name}价格`" /></td>
            <td><input v-model.number="item.cap" type="number" :min="item.mode === 'service' ? 0 : 1" :aria-label="`${item.name}持有上限`" /></td>
            <td><input :value="item.globalLimit ?? ''" type="number" min="0" placeholder="不限" :aria-label="`${item.name}全局限购`" @input="item.globalLimit = ($event.target as HTMLInputElement).value === '' ? undefined : ($event.target as HTMLInputElement).valueAsNumber" /></td>
            <td><input v-model.number="item.unlockLayer" type="number" min="1" placeholder="起始层 1" :aria-label="`${item.name}解锁层数`" /><input :value="item.endLayer ?? ''" type="number" :min="item.unlockLayer??1" placeholder="结束层不限" :aria-label="`${item.name}结束层数`" @input="item.endLayer=($event.target as HTMLInputElement).value===''?undefined:($event.target as HTMLInputElement).valueAsNumber" /></td><td>{{ { perUnit: '单件', fill: '补满', service: '服务' }[item.mode] }}</td><td><button :disabled="draft.supplyDrops?.entries.some(e=>e.itemId===item.id)" @click="draft.shop.splice(draft.shop.indexOf(item),1);shopCategory='全部'">移除</button><small v-if="draft.supplyDrops?.entries.some(e=>e.itemId===item.id)">清波补给正在使用</small></td></tr>
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
        <div class="toolbar"><NumberField v-model="previewLayer" label="预览层数" :min="1" :max="draft.pools.at(-1)?.to" /><label>人数<select v-model.number="players"><option :value="1">1 人</option><option :value="2">2 人</option><option :value="4">4 人 · 实机待验收</option></select></label></div>
        <label class="check"><input v-model="unlockAll" type="checkbox" />预览时解锁所有极强怪（仅影响预览）</label>
        <p v-if="previewResult.error" class="alert">{{ previewResult.error }}</p>
        <div class="choice-grid"><article v-for="choice in previewResult.choices" :key="choice.index" class="subpanel"><b>{{ choice.label }}</b><p>HP ×{{ fmt(choice.hpMul) }} · 伤害 ×{{ fmt(choice.dmgMul) }}</p><strong class="gold">{{ choice.rewardPt }} PT</strong></article></div>
        <h3>修改清单（{{ diff.length }}）</h3>
        <div class="table-scroll"><table><thead><tr><th>参数</th><th>载入值</th><th>草稿值</th></tr></thead><tbody><tr v-for="change in diff" :key="change.path"><td>{{ parameterLabel(change.path) }}</td><td>{{ JSON.stringify(change.before) ?? '未设置' }}</td><td>{{ JSON.stringify(change.after) ?? '移除' }}</td></tr></tbody></table></div>
        <p v-if="!diff.length" class="muted">还没有修改参数。</p>
      </div>
      </div><button class="preview-toggle" :aria-expanded="previewOpen" @click="previewOpen=!previewOpen">{{ previewOpen ? '收起预览' : '波次预览' }}</button><BalancePreview v-if="previewOpen" :draft="draft" :baseline="baseline" v-model:layer="previewLayer" v-model:players="players" v-model:unlocked="unlockAll" /></div>
      <details class="advanced"><summary @click="rawText = JSON.stringify(draft, null, 2)">高级：JSON 草稿</summary><textarea v-model="rawText" rows="12" aria-label="高级 JSON 草稿" spellcheck="false" /><button @click="applyRaw">将 JSON 应用到表单草稿</button></details>
      <div class="submit-bar"><div class="submit-copy" role="status" aria-live="polite"><strong :class="{ 'submit-saved': submitState.saved }">{{ submitState.message }}</strong><small>原商店价格下次交易生效；曲线和怪池下次生成生效；商品效果、装备、抽装池与增益下一局生效</small></div>
        <button class="primary" :disabled="submitState.disabled" :title="submitState.message" @click="submit">{{ submitState.label }}</button></div>
    </template>
  </section>
</template>

<style scoped>
.submit-copy{display:grid;gap:6px;flex:1;min-width:220px}.submit-copy small{opacity:.75}.submit-saved{color:#a9d59b}
.supply-editor{max-width:850px}.supply-editor>.number-field{max-width:240px}.supply-editor .equipment-entry{grid-template-columns:minmax(180px,1fr) 100px 100px auto;border-bottom:1px solid #443728;padding:10px 0;margin:0}.supply-editor select{width:100%;min-width:0}.pool-workbench{display:grid;grid-template-columns:minmax(220px,.85fr) minmax(300px,1.15fr);gap:16px;margin-top:14px}.pool-current{min-width:0;max-height:70vh;overflow:auto}.pool-current .equipment-entry{grid-template-columns:80px minmax(120px,1fr) 65px 48px auto;font-size:12px}.pool-current select{width:100%;min-width:0}.pool-current button{padding:8px}.scaling-workbench{display:grid;grid-template-columns:minmax(300px,1.2fr) minmax(260px,1fr);gap:20px;align-items:start}.scaling-workbench>.curve{position:sticky;top:12px}.scaling-controls{max-height:calc(100vh - 48px);overflow:auto;padding:0 8px}.scaling-controls h3{margin-top:10px}@media(max-width:1100px){.pool-workbench{grid-template-columns:1fr}.scaling-workbench{grid-template-columns:1fr}.scaling-workbench>.curve{top:0;z-index:3}.scaling-controls{max-height:45vh}}@media(max-width:600px){.supply-editor .equipment-entry{grid-template-columns:minmax(0,1fr) 70px 70px}.supply-editor .equipment-entry button{grid-column:1/-1}.pool-current .equipment-entry{grid-template-columns:1fr 1fr}}

.design-layout{display:grid;grid-template-columns:160px minmax(0,1fr);gap:18px;align-items:start;margin-top:20px}.design-nav{position:sticky;top:12px;display:grid;gap:7px}.design-nav button{text-align:left}.design-main{min-width:0}.editor-body{min-height:280px}.pool-selector{gap:6px}.equipment-entry{display:grid;grid-template-columns:100px minmax(110px,1fr) 95px 60px auto;gap:8px;align-items:end;margin:12px 0}.equipment-entry label{display:grid;gap:5px;font-size:12px}.equipment-entry input{width:100%}.submit-bar{z-index:6;position:static;flex-wrap:wrap}.preview-toggle{position:fixed;right:24px;bottom:24px;z-index:22;box-shadow:0 4px 20px #0008}.editor .table-scroll{max-height:65vh}.editor th{position:sticky;top:0;background:#201b15;z-index:1}.design-main .fields{grid-template-columns:repeat(2,minmax(0,1fr))}@media(max-width:1100px){.design-layout{grid-template-columns:140px minmax(0,1fr)}}@media(max-width:950px){.design-layout{grid-template-columns:1fr}.design-nav{position:static;display:flex;flex-wrap:wrap}.design-main .fields{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:600px){.design-main .fields{grid-template-columns:1fr}.equipment-entry{grid-template-columns:1fr 1fr}.equipment-entry button{grid-column:2}.submit-bar{position:static}}
</style>
