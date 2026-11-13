<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { RunEquipmentInventory } from './api';
const props=defineProps<{inventory?:RunEquipmentInventory;connected:boolean;busy:boolean;notice:string}>();
const emit=defineEmits<{command:[cmd:string,extra:Record<string,unknown>]; 'discard-request':[request:{equipmentKey:number;equipmentVersion:string}]} >();
const filter=ref('all'), search=ref(''), selected=ref<number|null>(null);
const parts=['武器','头部','胸部','腕部','腰部','脚部','花链','护石'];
const items=computed(()=>props.inventory?.items??[]);
const visible=computed(()=>items.value.filter(e=>(filter.value==='all'||String(e.position)===filter.value)&&`${e.name} ${e.id}`.includes(search.value)));
const worn=computed(()=>parts.map((name,position)=>({name,position,item:items.value.find(e=>e.position===position&&e.worn)})));
const discardNotice=ref('');
// Reserved integration point: consumers can implement disposal without changing wear commands.
const discardRequest=(key:number)=>{discardNotice.value=`装备 ${key}：丢弃功能尚未接入，装备仍保留在箱中。`;emit('discard-request',{equipmentKey:key,equipmentVersion:props.inventory?.version??''});};
function choose(key:number){selected.value=key;send('wear');}
const detail=computed(()=>items.value.find(e=>e.key===selected.value));
const locked=computed(()=>!props.connected||props.busy||!props.inventory?.canEdit||!!props.inventory.reason);
watch(()=>props.inventory?.version,()=>{if(!items.value.some(e=>e.key===selected.value))selected.value=items.value[0]?.key??null;},{immediate:true});
function send(sub:string,extra:Record<string,unknown>={}){
 if(locked.value||!detail.value)return;
 emit('command','equipment',{sub,equipmentKey:detail.value.key,equipmentVersion:props.inventory!.version,...extra});
}
function socket(slot:number,event:Event){
 const input=event.target as HTMLSelectElement;
 send('socket',{socket:slot,jewelId:Number(input.value)});
 input.value=String(detail.value?.sockets?.[slot]??0);
}
</script>

<template>
 <section class="panel wardrobe">
  <div class="section-heading"><div><p class="eyebrow">本局构筑</p><h2>局内装备箱</h2></div><span class="badge">{{ items.length }} 件装备</span></div>
  <p class="muted">初始装备与本局获得的装备集中在这里。换装和镶嵌仅在整备阶段开放，珠子仅使用本局所得。</p>
  <p v-if="notice" class="notice" role="status">{{ notice }}</p>
  <p v-if="!connected" class="alert">等待连接游戏，装备操作已暂停。</p>
  <p v-else-if="inventory?.reason" class="notice">{{ inventory.reason.replace('Error: ', '') }}</p>
  <p v-else-if="!inventory?.canEdit" class="notice">可查看本局装备；请在开局准备或清波集结后的整备阶段调整。</p>
  <div class="wardrobe-columns">
   <div>
    <h3>装备箱</h3><p class="muted">点击右侧部位筛选，点击箱中装备即可穿戴。</p>
    <div class="toolbar"><label>部位 <select v-model="filter"><option value="all">全部部位</option><option v-for="(name,i) in parts" :key="i" :value="String(i)">{{ name }}</option></select></label><label>搜索 <input v-model="search" placeholder="装备名称 / ID" /></label></div>
    <p v-if="!visible.length" class="empty">{{ items.length?'没有符合条件的装备。':'本局装备会在准备成功或奖励发放后显示。' }}</p>
    <div class="equipment-list"><button v-for="item in visible" :key="item.key" :class="['equipment-card',{selected:selected===item.key}]" :aria-pressed="selected===item.key" @click="choose(item.key)" :disabled="locked"><span>{{ parts[item.position] }} <span v-if="item.worn" class="badge live">已穿戴</span></span><strong>{{ item.name || `装备 ${item.id}` }}</strong><small>{{ item.inherited?'继承武器':'本局临时装备' }}</small></button></div>
   </div>
   <aside class="equipment-detail"><h3>当前穿戴</h3><div class="worn-list"><button v-for="slot in worn" :key="slot.position" :class="{selected:filter===String(slot.position)}" @click="filter=String(slot.position);selected=slot.item?.key??null"><span>{{ slot.name }}</span><strong>{{ slot.item?.name ?? '无本局装备' }}</strong></button></div><template v-if="detail">
    <p class="eyebrow">{{ parts[detail.position] }}</p><h3>{{ detail.name }}</h3>
    <button class="primary" :disabled="locked||detail.worn" @click="send('wear')">{{ detail.worn?'当前已穿戴':'穿戴这件装备' }}</button>
    <button :disabled="detail.worn||detail.inherited" @click="discardRequest(detail.key)">丢弃（预留接口）</button><p v-if="discardNotice" role="status" class="muted">{{ discardNotice }}</p><h3>装饰品</h3>
    <p v-if="detail.inherited" class="muted">继承武器保留原配置，本局暂不开放改珠。</p>
    <template v-else>
     <p v-if="!detail.sockets?.length" class="muted">这件装备没有普通装饰品孔位。</p>
     <p class="muted">选择本局珠子装入；孔位兼容性由游戏校验。不兼容的镶嵌会被拒绝。</p>
     <label v-for="(id,slot) in detail.sockets??[]" :key="slot" class="socket">孔位 {{ slot+1 }} · {{ detail.slotLevels?.[slot] }} 级<select :value="id" :disabled="locked" @change="socket(slot,$event)"><option :value="0">空 / 卸下珠子</option><option v-for="jewel in inventory?.jewels??[]" :key="jewel.id" :value="jewel.id" :disabled="(jewel.available<=0&&jewel.id!==id)||jewel.level>(detail.slotLevels?.[slot]??0)">{{ jewel.name || `珠子 ${jewel.id}` }} · 可用 {{ jewel.available }}</option></select></label>
    </template>
    <h3>本局珠子</h3>
    <p v-if="!inventory?.jewels?.length" class="muted">尚未获得珠子。获得后可在这里镶嵌；卸下的珠子回到本局库存。</p>
    <ul v-else><li v-for="jewel in inventory.jewels" :key="jewel.id">{{ jewel.name }}：可用 {{ jewel.available }} / 共 {{ jewel.count }}</li></ul>
   </template></aside>
  </div>
 </section>
</template>

<style scoped>
.worn-list{display:grid;gap:7px}.worn-list button{display:flex;justify-content:space-between;gap:12px;text-align:left}.worn-list strong{font-size:13px}

.wardrobe-columns{display:grid;grid-template-columns:minmax(0,1.5fr) minmax(260px,1fr);gap:28px;margin-top:24px}.equipment-list{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px}.equipment-card{display:flex;flex-direction:column;align-items:flex-start;gap:10px;text-align:left;padding:16px;min-height:116px}.equipment-card strong{font-size:16px}.equipment-card small{opacity:.75}.equipment-detail{border-left:1px solid #4a3e2c;padding-left:24px}.equipment-detail h3{margin:22px 0 12px}.socket{display:flex;flex-direction:column;gap:6px;margin:14px 0}.socket select{width:100%}.toolbar input{max-width:220px}
@media(max-width:800px){.wardrobe-columns{grid-template-columns:1fr}.equipment-detail{border-left:0;border-top:1px solid #4a3e2c;padding:8px 0}.toolbar{align-items:stretch;flex-direction:column}}
</style>
