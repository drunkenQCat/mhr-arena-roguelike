<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { EffectDefinition, EffectProduct, EffectGroup, EffectPhase } from '../../src/core/effect_contract';
import { copyEffectValue } from '../../src/core/effect_contract';
import type { EffectSnapshot } from './EffectShop.vue';
import {effectPhases,effectWeapons,effectProductIssue,previewEffectProduct,effectItemName} from './effect-model';
import type { RogueConfig } from '../../src/core/config';
import catalog from '../../data/game_catalog.json';
const props=defineProps<{modelValue:RogueConfig['effectShop'];definitions:EffectDefinition[];live?:EffectSnapshot|null}>();
const emit=defineEmits<{'update:modelValue':[value:NonNullable<RogueConfig['effectShop']>]} >();
const selected=ref(''),message=ref(''),previewLayer=ref(1),previewPt=ref(150),itemSearch=ref('');
const previewPhase=ref<EffectPhase>('Selecting'),previewWeapon=ref(2),previewUsed=ref(0),previewPurchases=ref(0),previewOccupied=ref<string[]>([]);
const settings=computed(()=>props.modelValue??{groups:{},products:[]});
const current=computed(()=>settings.value.products.find(p=>p.id===selected.value));
const definition=computed(()=>{const d=props.definitions.find(d=>d.id===current.value?.effect.id);return d?{...d,parameters:d.parameters??{}}:undefined;});
const issues=computed(()=>settings.value.products.flatMap(p=>{const reason=effectProductIssue(p,props.definitions,settings.value.groups);return reason?[{id:p.id,name:p.name,enabled:p.enabled,reason}]:[];}));
const active=computed(()=>props.live?.offers?.find(e=>e.offer.id===selected.value));
const otherGroups=computed(()=>Object.keys(settings.value.groups).filter(id=>id!==definition.value?.group));
watch(()=>settings.value.products.map(p=>p.id),ids=>{if(!ids.includes(selected.value))selected.value=ids[0]??'';},{immediate:true});
const newId=()=>`effect_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,12)}`;
const itemChoices=computed(()=>catalog.entries.filter(e=>e.kind==='item'&&e.name.includes(itemSearch.value)).slice(0,150));
function update(change:(value:NonNullable<RogueConfig['effectShop']>)=>void){const next=copyEffectValue(settings.value);change(next);emit('update:modelValue',next);}
function defaults(d:EffectDefinition){return Object.fromEntries(Object.entries(d.parameters??{}).map(([k,p])=>[k,p.default]));}
function ensureGroup(groups:Record<string,EffectGroup>,d:EffectDefinition){groups[d.group]??={policy:'add',cap:d.quantityParameter?Math.min(d.parameters[d.quantityParameter].max,30):99};}
function add(){const d=props.definitions[0];if(!d){message.value='请连接已部署效果目录的游戏';return;}const id=newId();selected.value=id;
 update(v=>{ensureGroup(v.groups,d);v.products.push({id,name:d.name,price:30,enabled:true,effect:{id:d.id,version:d.version,parameters:defaults(d)},conditions:{phases:['Selecting'],fromLayer:1,toLayer:999,weapons:[],exclusiveGroups:[]}});});}
function patch(change:(p:EffectProduct)=>void){update(v=>{const p=v.products.find(p=>p.id===selected.value);if(p)change(p);});}
function chooseEffect(id:string){const d=props.definitions.find(v=>v.id===id);if(!d)return;update(v=>{const p=v.products.find(p=>p.id===selected.value)!;ensureGroup(v.groups,d);p.effect={id:d.id,version:d.version,parameters:defaults(d)};
 const supported=d.supportedPhases??['Preparing','Selecting'];p.conditions.phases=p.conditions.phases.filter(phase=>supported.includes(phase));if(!p.conditions.phases.length)p.conditions.phases=[supported[0] as EffectPhase];p.conditions.exclusiveGroups=p.conditions.exclusiveGroups.filter(g=>g!==d.group);});message.value='已按当前定义重建草稿参数，请重新检查数值；已购订单保留原参数。';}
function duplicate(){if(!current.value)return;const source=copyEffectValue(current.value),id=newId();
 update(v=>v.products.push({...source,id,name:`${source.name}（副本）`}));selected.value=id;message.value='已复制；效果组与组上限仍共享，商品价格和限购可独立修改。';}
function toggle(field:'weapons'|'exclusiveGroups'|'phases',value:number|string,checked:boolean){patch(p=>{const next=(p.conditions[field] as (number|string)[]).filter(v=>v!==value);if(checked)next.push(value);(p.conditions as unknown as Record<string,unknown>)[field]=next;});}
function phaseSupported(phase:EffectPhase){return (definition.value?.supportedPhases??['Preparing','Selecting']).includes(phase);}
const preview=computed(()=>{const p=current.value,d=definition.value;if(!p||!d)return null;try{return previewEffectProduct(p,d,settings.value.groups[d.group],{layer:previewLayer.value,pt:previewPt.value,phase:previewPhase.value,weapon:previewWeapon.value,groupUsed:previewUsed.value,purchaseCount:previewPurchases.value,occupiedGroups:previewOccupied.value});
 }catch(e){return {description:'',reason:String(e),unitCost:''};}});
</script>
<template>
 <section class="effect-designer">
  <h3>商品效果 <span class="badge">Instance1 实验</span></h3>
  <p class="muted">草稿修改 → 校验并提交 → 下一局生效。当前局商品与已购订单保留原规则。下一波效果先预留 PT；立即交付核验后扣款。当前实机实验限定单人。</p>
  <p v-if="live?.configuration?.nextRunPending" class="notice">已有提交的下一局效果规则，当前局仍使用旧规则。</p>
  <div class="toolbar"><button @click="add">新增效果商品</button><button :disabled="!current" @click="duplicate">复制商品</button></div>
  <p v-if="message" role="status">{{ message }}</p>
  <aside v-if="issues.length" class="alert" role="status"><strong>需要处理的商品</strong><ul><li v-for="issue in issues" :key="issue.id"><button @click="selected=issue.id">{{issue.name}}</button>：{{issue.reason}}（{{issue.enabled?'上架商品会阻止提交':'已下架，可保留记录'}}）</li></ul></aside>
  <div class="effect-layout"><nav aria-label="效果商品"><button v-for="p in settings.products" :key="p.id" :class="{selected:p.id===selected}" @click="selected=p.id">{{p.name}} · {{p.price}} PT{{p.enabled?'':' · 已下架'}}</button></nav>
   <section v-if="current">
    <label>商品名称<input :value="current.name" @input="patch(p=>p.name=($event.target as HTMLInputElement).value)" /></label>
    <div class="fields"><label>价格（PT）<input type="number" min="0" step="1" :value="current.price" @input="patch(p=>p.price=Number(($event.target as HTMLInputElement).value))" /></label>
    <label class="check"><input type="checkbox" :checked="current.enabled" @change="patch(p=>p.enabled=($event.target as HTMLInputElement).checked)" />上架（下架不撤销已购效果）</label></div>
    <label>效果<select :value="current.effect.id" @change="chooseEffect(($event.target as HTMLSelectElement).value)"><option v-if="!definition" :value="current.effect.id">不可用：{{current.effect.id}}</option><option v-for="d in definitions" :key="d.id" :value="d.id">{{d.name}}</option></select></label>
    <button v-if="definition" @click="chooseEffect(definition.id)">按当前定义重建参数</button>
    <p v-if="!definition||!settings.groups[definition.group]" class="alert">效果或效果组不可用。请选择其他效果，或下架此商品；已购订单保留原回执。</p>
    <template v-if="definition&&settings.groups[definition.group]">
    <p>{{definition.description}}</p><p class="muted">购买者付款并受益 · {{definition.delivery==='nextWave'?'下一完整波次，顺序双怪全程有效':'立即交付'}} · 验证级别：{{definition.verification==='attribute'?'原生属性／数量读回':definition.verification==='combat'?'实际战斗验证':'仅登记'}}</p>
    <div v-for="(p,key) in definition.parameters" :key="key">
     <template v-if="key==='itemId'"><label>搜索道具<input v-model="itemSearch" placeholder="输入中文名称" /></label><label>发放道具<select :value="current.effect.parameters[key]" @change="patch(v=>v.effect.parameters[key]=Number(($event.target as HTMLSelectElement).value))"><option :value="current.effect.parameters[key]">{{effectItemName(current.effect.parameters[key])??`未识别道具（ID ${current.effect.parameters[key]}）`}}</option><option v-for="item in itemChoices" :key="item.id" :value="item.id">{{item.name}}</option></select></label></template>
     <label v-else>{{p.name}}（{{p.unit}}）<input type="number" :min="p.min" :max="p.max" :step="p.integer?1:'any'" :value="current.effect.parameters[key]" @input="patch(v=>v.effect.parameters[key]=Number(($event.target as HTMLInputElement).value))" /></label><small>{{p.description}} · {{p.min}}–{{p.max}} {{p.unit}}</small>
    </div>
    <h4>效果组：{{definition.name}}</h4><p class="muted">复制或重命名商品仍共用本组。上限同时计算已生效和预留量；超出时拒绝，不截断收费。</p>
    <label>叠加方式<select :value="settings.groups[definition.group].policy" @change="update(v=>v.groups[definition!.group].policy=($event.target as HTMLSelectElement).value as EffectGroup['policy'])"><option value="add">叠加至组上限</option><option value="unique">本波不可重复</option><option value="replace">升级须先取消旧预订，按新商品完整预订</option></select></label>
    <label>全组上限<input type="number" min="1" :value="settings.groups[definition.group].cap" @input="update(v=>v.groups[definition!.group].cap=Number(($event.target as HTMLInputElement).value))" /></label>
    <h4>购买条件</h4><fieldset><legend>允许购买的阶段</legend><label v-for="phase in effectPhases" :key="phase.id" class="check"><input type="checkbox" :disabled="!phaseSupported(phase.id)" :checked="current.conditions.phases.includes(phase.id)" @change="toggle('phases',phase.id,($event.target as HTMLInputElement).checked)" />{{phase.name}}{{phaseSupported(phase.id)?'':'（此效果不支持）'}}</label></fieldset>
    <div class="fields"><label>开放起层<input type="number" min="1" :value="current.conditions.fromLayer" @input="patch(p=>p.conditions.fromLayer=Number(($event.target as HTMLInputElement).value))" /></label><label>开放末层<input type="number" min="1" :value="current.conditions.toLayer" @input="patch(p=>p.conditions.toLayer=Number(($event.target as HTMLInputElement).value))" /></label></div>
    <fieldset><legend>武器限制（不选表示不限）</legend><div class="checks"><label v-for="[id,name] in effectWeapons" :key="id" class="check"><input type="checkbox" :checked="current.conditions.weapons.includes(id)" @change="toggle('weapons',id,($event.target as HTMLInputElement).checked)" />{{name}}</label></div></fieldset>
    <fieldset><legend>互斥效果组（已生效或预留时禁止购买）</legend><label v-for="id in otherGroups" :key="id" class="check"><input type="checkbox" :checked="current.conditions.exclusiveGroups.includes(id)" @change="toggle('exclusiveGroups',id,($event.target as HTMLInputElement).checked)" />{{definitions.find(d=>d.group===id)?.name??id}}</label><p v-if="!otherGroups.length" class="muted">还没有其他效果组。</p></fieldset>
    <label>限购范围<select :value="current.conditions.limit?.scope??'none'" @change="patch(p=>{const scope=($event.target as HTMLSelectElement).value;p.conditions.limit=scope==='none'?undefined:{count:p.conditions.limit?.count??1,scope:scope as NonNullable<EffectProduct['conditions']['limit']>['scope']};})"><option value="none">不限购</option><option value="playerWave">每人每波</option><option value="playerRun">每人每局</option><option value="teamWave">全队每波（联机实测待接线）</option><option value="teamRun">全队每局（联机实测待接线）</option></select></label>
    <label v-if="current.conditions.limit">限购次数<input type="number" min="0" :value="current.conditions.limit.count" @input="patch(p=>p.conditions.limit!.count=Number(($event.target as HTMLInputElement).value))" /></label>
    <h4>规则预览 · 不执行脚本、不扣 PT、不消耗抽取随机序列</h4>
    <div class="fields"><label>预览层数<input v-model.number="previewLayer" type="number" min="1" /></label><label>预览可用 PT<input v-model.number="previewPt" type="number" min="0" /></label><label>预览阶段<select v-model="previewPhase"><option v-for="phase in effectPhases" :key="phase.id" :value="phase.id">{{phase.name}}</option></select></label><label>预览武器<select v-model.number="previewWeapon"><option v-for="[id,name] in effectWeapons" :key="id" :value="id">{{name}}</option></select></label><label>本组已生效＋待生效量<input v-model.number="previewUsed" type="number" min="0" /></label><label>已占本商品限购次数<input v-model.number="previewPurchases" type="number" min="0" max="128" /></label></div>
    <fieldset v-if="otherGroups.length"><legend>模拟占用其他效果组</legend><label v-for="id in otherGroups" :key="id" class="check"><input v-model="previewOccupied" type="checkbox" :value="id" />{{definitions.find(d=>d.group===id)?.name??id}}</label></fieldset>
    <p v-if="preview?.reason" class="alert">{{preview.reason}}</p><p v-else class="notice">规则允许购买；原生背包容量等条件仍须实机检查。</p><p>{{preview?.description}}</p><small>{{preview?.unitCost}}</small>
    <h4>本局与草稿</h4><p v-if="active">本局：{{active.offer.price}} PT · {{active.description}}</p><p v-else class="muted">本局没有此商品。新商品须提交后在下一局使用。</p><p>草稿：{{current.price}} PT · {{preview?.description||'请先修正配置'}}</p>
    <details><summary>程序信息</summary><p>{{definition.id}} · 版本 {{definition.version}} · 稳定效果组 {{definition.group}}</p><code>{{definition.implementation}}</code></details>
    </template>
   </section><p v-else class="muted">选择一个商品，或点击“新增效果商品”。</p>
  </div>
 </section>
</template>
<style scoped>
.effect-layout{display:grid;grid-template-columns:240px minmax(0,1fr);gap:20px;margin-top:18px}.effect-layout nav{display:grid;align-content:start;gap:8px}.effect-layout nav button{text-align:left}.effect-layout label{display:grid;gap:6px;margin:12px 0}.effect-layout small{display:block;opacity:.75}.effect-layout code{overflow-wrap:anywhere}.effect-layout .check{display:flex;align-items:center}@media(max-width:750px){.effect-layout{grid-template-columns:1fr}}
.checks{display:grid;grid-template-columns:repeat(auto-fit,minmax(90px,1fr))}.effect-layout fieldset{min-width:0;border:1px solid #655236;border-radius:8px;margin:16px 0;padding:12px}.effect-layout .check{gap:8px}.alert button{padding:2px 5px}</style>
