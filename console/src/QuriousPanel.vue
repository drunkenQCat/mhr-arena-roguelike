<script setup lang="ts">
import {ref,computed} from 'vue';
import type {RunEquipmentInventory,ArmorView} from './api';
const props=defineProps<{inventory:RunEquipmentInventory;equipmentKey:number;locked:boolean;pt:number}>();
const emit=defineEmits<{action:[sub:string,extra:Record<string,unknown>]}>();
const mode=ref(0);
const item=computed(()=>props.inventory.items?.find(x=>x.key===props.equipmentKey));
const pending=computed(()=>props.inventory.quriousPending?.key===props.equipmentKey?props.inventory.quriousPending.candidate:null);
const price=computed(()=>props.inventory.quriousPrice??60);
const skills=(v:ArmorView)=>v.skills?.filter(x=>x.level>0).map(x=>`${x.name} ${x.level}`).join('、')||'无';
const slots=(v:ArmorView)=>v.slots?.join(' / ')||'无';
</script>
<template>
 <section v-if="item && item.position>=1 && item.position<=5" class="qurious-panel">
  <h3>傀异炼化 <span class="badge">本局装备强化</span></h3>
  <p v-if="!item.qurious?.supported" class="muted">此防具不支持原生傀异炼化。获得可炼化的大师位防具后开放。</p>
  <template v-else>
   <p class="muted">原版算法生成，接受后叠加到这件防具。正负效果一并保留，不占珠子孔位。本局结束回收。</p>
   <label>炼化方式 <select v-model.number="mode" :disabled="locked||!!inventory.quriousPending"><option :value="0">通常炼化</option><option :value="3">安定型</option><option :value="1">技能特化</option><option :value="2">孔位特化</option></select></label>
   <button class="primary" :disabled="locked||!!inventory.quriousPending||pt<price" @click="emit('action','quriousRoll',{quriousMode:mode})">花 {{price}} PT 生成一次结果</button>
   <p class="muted">生成时扣款；保留原状不退款。原生结果容量为 7 项，累计效果合并后仍须通过原生检查。</p>
   <div v-if="pending" aria-live="polite">
    <table><thead><tr><th>装备能力</th><th>当前</th><th>接受后</th></tr></thead><tbody>
     <tr><th>防御</th><td>{{pending.before.defense}}</td><td :class="{'positive':pending.after.defense>pending.before.defense,'negative':pending.after.defense<pending.before.defense}">{{pending.after.defense}}</td></tr>
     <tr><th>孔位</th><td>{{slots(pending.before)}}</td><td>{{slots(pending.after)}}</td></tr>
     <tr><th>技能</th><td>{{skills(pending.before)}}</td><td>{{skills(pending.after)}}</td></tr>
     <tr><th>火 / 水 / 雷 / 冰 / 龙</th><td>{{pending.before.resistance?.join(' / ')}}</td><td>{{pending.after.resistance?.join(' / ')}}</td></tr>
    </tbody></table>
    <h4>本次生成的变化</h4><ul><li v-for="(change,i) in pending.changes" :key="i">{{change}}</li></ul>
    <p v-if="!pending.canAccept" class="alert">无法完整叠加：{{pending.reason?.replace('Error: ','')}}。当前装备未修改。</p>
    <div class="actions"><button class="primary" :disabled="locked||!pending.canAccept" @click="emit('action','quriousAccept',{})">接受并叠加</button><button :disabled="locked" @click="emit('action','quriousKeep',{})">保留当前装备</button></div>
   </div>
   <p v-else-if="item.qurious.view" class="muted">当前防御 {{item.qurious.view.defense}} · 孔位 {{slots(item.qurious.view)}} · {{skills(item.qurious.view)}}</p>
  </template>
 </section>
</template>
<style scoped>
.qurious-panel{margin:24px 0;padding-top:12px;border-top:1px solid #655b42}select{width:100%;margin:8px 0 12px}table{width:100%;font-size:13px;margin-top:18px;border-collapse:collapse}th,td{padding:8px 5px;text-align:left;vertical-align:top;border-bottom:1px solid #655b42;overflow-wrap:anywhere}th{font-weight:500}.positive{color:#91cb94}.negative{color:#f19c8c}.actions{display:flex;gap:10px;flex-wrap:wrap}
</style>
