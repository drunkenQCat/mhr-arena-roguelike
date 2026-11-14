import {expect,it} from 'vitest';
import {previewEffectProduct,effectProductIssue,readableEffectDescription,type EffectPreviewScenario} from './effect-model';
import type {EffectDefinition,EffectProduct,EffectOffer} from '../../src/core/effect_contract';
const definition:EffectDefinition={id:'attack',version:'1',implementation:'source',name:'攻击',description:'属性',delivery:'nextWave',verification:'attribute',experimental:false,group:'attack',quantityParameter:'amount',supportedPhases:['Selecting'],parameters:{amount:{name:'加成',description:'点数',unit:'点',min:1,max:30,default:10}}};
const product:EffectProduct={id:'small',name:'小攻击',price:30,enabled:true,effect:{id:'attack',version:'1',parameters:{amount:10}},conditions:{phases:['Selecting'],fromLayer:1,toLayer:99,weapons:[2],exclusiveGroups:['defense'],limit:{scope:'teamRun',count:1}}};
const group={cap:30,policy:'add' as const};
const scenario:EffectPreviewScenario={layer:1,pt:150,phase:'Selecting',weapon:2,groupUsed:0,purchaseCount:0,occupiedGroups:[]};
it('shows a real item name in player-facing descriptions while retaining the numeric native binding',()=>{
 const offer:EffectOffer={...product,effect:{id:'item.grant',version:'1',parameters:{itemId:68157446}},revision:'r1',groupRule:group,
  definition:{...definition,id:'item.grant',delivery:'instant',quantityParameter:null,parameters:{itemId:{...definition.parameters.amount,name:'游戏道具 ID',unit:'ID'}}}};
 const text=readableEffectDescription(offer);expect(text).toContain('回复药');expect(text).not.toContain('68157446');expect(offer.effect.parameters.itemId).toBe(68157446);
});
it('previews actual ledger stage, weapon, quota, exclusivity and pending-cap rules without executing effects',()=>{
 expect(previewEffectProduct(product,definition,group,scenario).reason).toBeNull();
 expect(previewEffectProduct(product,definition,group,{...scenario,phase:'Combat'}).reason).toContain('阶段');
 expect(previewEffectProduct(product,definition,group,{...scenario,weapon:0}).reason).toContain('武器');
 expect(previewEffectProduct(product,definition,group,{...scenario,purchaseCount:1}).reason).toContain('限购');
 expect(previewEffectProduct(product,definition,group,{...scenario,groupUsed:21}).reason).toContain('上限');
 expect(previewEffectProduct(product,definition,group,{...scenario,occupiedGroups:['defense']}).reason).toContain('互斥');
});
it('reports missing versions and groups as editable product issues',()=>{
 expect(effectProductIssue(product,[],{})).toContain('目录');
 expect(effectProductIssue(product,[definition],{})).toContain('效果组');
 expect(effectProductIssue({...product,effect:{...product.effect,version:'old'}},[definition],{attack:group})).toContain('版本');
});
