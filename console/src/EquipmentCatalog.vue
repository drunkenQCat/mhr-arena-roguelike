<script setup lang="ts">
import {computed,ref,onMounted} from 'vue';
import gameCatalog from '../../data/game_catalog.json';
export interface CatalogEntry{kind:'weapon'|'armor'|'decoration'|'item';id:number;name:string}
const props=withDefaults(defineProps<{kinds?:CatalogEntry['kind'][]}>(),{kinds:()=>['armor','weapon','decoration']});
const kindNames={armor:'防具',weapon:'武器',decoration:'装饰品',item:'道具'};
const emit=defineEmits<{add:[entry:CatalogEntry];loaded:[entries:CatalogEntry[]]}>();
const entries=ref<CatalogEntry[]>(gameCatalog.entries as CatalogEntry[]),search=ref(''),kind=ref(props.kinds[0]),message=ref('');
onMounted(()=>emit('loaded',entries.value));
const filtered=computed(()=>entries.value.filter(e=>e.kind===kind.value&&`${e.name} ${e.id}`.toLowerCase().includes(search.value.toLowerCase())));
async function load(event:Event){try{const file=(event.target as HTMLInputElement).files?.[0];if(!file)return;if(file.size>8000000)throw Error('目录文件超过 8 MB');const raw=JSON.parse(await file.text());if(raw.schema!==1||!Array.isArray(raw.entries))throw Error('需要游戏导出的 schema 1 目录');const seen=new Set<string>();for(const e of raw.entries){if(!['weapon','armor','decoration','item'].includes(e.kind)||!Number.isInteger(e.id)||e.id<=0||e.id>4294967295||typeof e.name!=='string'||!e.name.trim())throw Error('目录条目无效');if(seen.has(`${e.kind}:${e.id}`))throw Error('目录存在重复条目');seen.add(`${e.kind}:${e.id}`);}entries.value=raw.entries;emit('loaded',entries.value);message.value=`已载入 ${entries.value.length} 条原生名称`; }catch(e){message.value=String(e);}}
function drag(event:DragEvent,entry:CatalogEntry){event.dataTransfer?.setData('application/x-rogue-equipment',JSON.stringify(entry));}
</script>
<template><section class="subpanel"><h3>游戏装备目录</h3><details><summary>更新目录</summary><label>导入游戏目录 JSON<input type="file" accept=".json" @change="load"></label></details><p role="status" class="muted">{{ message || '已内置当前游戏导出的中文目录。需要刷新版本时可导入新的游戏目录。' }}</p><div class="toolbar"><select v-model="kind" aria-label="目录类型"><option v-for="k in kinds" :key="k" :value="k">{{ kindNames[k] }}</option></select><input v-model="search" placeholder="中文名称 / ID" aria-label="搜索游戏目录"></div><p class="muted">{{ filtered.length }} 项；搜索缩小范围。点击添加到当前抽取池，也可拖到抽取池上。</p><div class="catalog-list"><button v-for="entry in filtered.slice(0,100)" :key="`${entry.kind}:${entry.id}`" draggable="true" @dragstart="drag($event,entry)" @click="emit('add',entry)">{{ entry.name }}<small>#{{ entry.id }}</small></button></div></section></template>
<style scoped>.catalog-list{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:6px;max-height:52vh;overflow:auto}.catalog-list button{text-align:left;padding:8px}.catalog-list small{font-size:11px}</style>
