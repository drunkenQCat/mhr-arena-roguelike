import {copyEffectValue, effectDescription, validateEffectProduct, type EffectDefinition, type EffectGroup, type EffectOffer, type EffectProduct, type EffectPhase} from '../../src/core/effect_contract';
import {EffectOrders, type EffectContext, type EffectOrder} from '../../src/core/effect_orders';
import gameCatalog from '../../data/game_catalog.json';
const itemNames:Record<number,string>=Object.fromEntries(gameCatalog.entries.filter(e=>e.kind==='item').map(e=>[e.id,e.name]));
export function effectItemName(id:number):string|undefined{return itemNames[id];}
export function readableEffectDescription(offer:EffectOffer):string{
 const name=offer.definition.id==='item.grant'?effectItemName(offer.effect.parameters.itemId):undefined;
 return effectDescription({...offer,definition:{...offer.definition,parameters:offer.definition.parameters??{}}},name?{itemId:`发放道具 ${name}`} : undefined);
}

/** snow.player.PlayerWeaponType, not equipment IDs or GUI sort order. */
export const effectWeapons=[
 [0,'大剑'],[1,'斩斧'],[2,'太刀'],[3,'轻弩'],[4,'重弩'],[5,'大锤'],[6,'铳枪'],
 [7,'长枪'],[8,'片手剑'],[9,'双剑'],[10,'狩猎笛'],[11,'盾斧'],[12,'操虫棍'],[13,'弓'],
] as const;
export const effectPhases: {id:EffectPhase;name:string}[]=[
 {id:'Preparing',name:'开局准备'},{id:'Selecting',name:'波间整备'},
 {id:'Carve',name:'剥取等待'},{id:'Combat',name:'战斗中'},
];
export function effectProductIssue(p:EffectProduct,definitions:EffectDefinition[],groups:Record<string,EffectGroup>):string|null{
 const raw=definitions.find(d=>d.id===p.effect.id);
 if(!raw)return '效果不在已加载目录中；请下架或选择其他效果';
 const d={...raw,parameters:raw.parameters??{}};
 const group=groups[d.group];if(!group)return '效果组已缺失；请重新选择效果以修复';
 try{validateEffectProduct(p,d,group);return null;}catch(e){return String(e).replace(/^Error: /,'');}
}
export interface EffectPreviewScenario {layer:number;pt:number;phase:EffectPhase;weapon:number;groupUsed:number;purchaseCount:number;occupiedGroups:string[]}
/** Uses the actual ledger's eligibility rules. No script, native API, charge,
 * persistence or RNG can run through this preview port. */
export function previewEffectProduct(p:EffectProduct,d:EffectDefinition,group:EffectGroup,input:EffectPreviewScenario){
 validateEffectProduct(p,d,group);
 if(!Number.isFinite(input.groupUsed)||input.groupUsed<0||!Number.isInteger(input.purchaseCount)||input.purchaseCount<0||input.purchaseCount>128)
   throw new Error('预览占用量和次数必须为非负数；次数不超过 128');
 const offer:EffectOffer={...copyEffectValue(p),definition:copyEffectValue(d),groupRule:copyEffectValue(group),revision:'preview-only'};
 const context:EffectContext={run:'preview',player:'buyer',wave:'preview/wave',team:['buyer'],layer:input.layer,phase:input.phase,weapon:input.weapon};
 const records:EffectOrder[]=[];
 function commitment(value:EffectOffer,id:string){records.push({id,requestId:id,context:copyEffectValue(context),offer:value,state:'active',charged:true,message:'preview fixture'});}
 if(input.groupUsed>0){const used=copyEffectValue(offer);used.id='group-occupancy';used.definition.quantityParameter='previewAmount';used.effect.parameters={previewAmount:input.groupUsed};commitment(used,'group-occupancy');}
 for(let i=0;i<input.purchaseCount;i++){const used=copyEffectValue(offer);used.definition.group='quota-history';commitment(used,`purchase-${i}`);}
 for(const occupied of input.occupiedGroups){const used=copyEffectValue(offer);used.id=`occupied-${occupied}`;used.definition.group=occupied;used.conditions.exclusiveGroups=[];commitment(used,`occupied-${occupied}`);}
 const forbidden=()=>{throw new Error('规则预览禁止执行真实效果');};
 const engine=new EffectOrders({balance:()=>input.pt,charge:forbidden,apply:forbidden,inspect:forbidden,remove:forbidden,persist:forbidden,check:()=>null,fingerprint:()=>''},records);
 return {description:readableEffectDescription(offer),reason:engine.check(offer,context),
   unitCost:d.quantityParameter?`每 10 PT 约 ${p.price>0?(p.effect.parameters[d.quantityParameter]*10/p.price).toFixed(2):'免费'} ${d.parameters[d.quantityParameter].unit}`:'此效果不作数值收益换算'};
}
