/** Native armor augmentation. Only detached copies are used for generation/preview. */
import { createInstance, createManagedArray, findTypeDefinition, callNativeFunction, type REManagedObject } from './sdk';
import { retainEquipmentObject } from './equipment_update';
import { canonical } from './wire_canonical';
export interface QuriousRow { id:number; index:number; skill:number }
export interface ArmorView { defense:number; slots:number[]; skills:{id:number;name:string;level:number}[]; resistance:number[] }
export interface QuriousCandidate { mode:number; rows:QuriousRow[]; before:ArmorView; after:ArmorView; changes:string[]; canAccept:boolean; reason:string|null }
const INVENTORY='snow.data.EquipmentInventoryData', RESULT=INVENTORY+'.CustomBuildupResult';
function obj(v:unknown):REManagedObject { if(!v)throw new Error('原生炼化数据不可用');return v as REManagedObject; }
function invoke(o:REManagedObject|null,type:string,name:string,...args:unknown[]):unknown {
 const td=findTypeDefinition(type);if(!td)throw new Error(`原生炼化类型不可用：${type}`);
 try{return callNativeFunction(o as REManagedObject,td,name,...args);}catch(error){throw new Error(`${type}.${name}: ${String(error)}`);}
}
function fresh(type:string):REManagedObject {const o=obj(createInstance(type,true));retainEquipmentObject(o);return o;}
export function armorCopy(e:REManagedObject):REManagedObject {
 const copy=fresh(INVENTORY);invoke(copy,INVENTORY,'.ctor');invoke(copy,INVENTORY,'copy',e);return copy;
}
export function quriousRows(e:REManagedObject):QuriousRow[] {
 const a=obj(e.call('get_CustomBuildup')) as REManagedObject&{get_size():number};const out:QuriousRow[]=[];
 for(let i=0;i<a.get_size();i++){const x=a.call('get_Item',i) as REManagedObject|null;if(x&&x.call('isValied'))out.push({id:x.get_field('_Id') as number,index:x.get_field('_ValueIndex') as number,skill:x.get_field('_SkillId') as number});}
 return out;
}
export function writeQurious(e:REManagedObject,rows:QuriousRow[],mode:number):void {
 const max=invoke(null,INVENTORY,'get_CustomBuildupResultMax') as number;
 if(rows.length>max)throw new Error(`原生炼化最多容纳 ${max} 项结果，本次无法叠加`);
 if(e.call('get_CustomEnable')!==true)invoke(e,INVENTORY,'setCustomStartup');
 const a=createManagedArray(RESULT,max);retainEquipmentObject(a);
 // Native setter copies all seven entries, including empty initialized results.
 // Null array elements are not equivalent to empty CustomBuildupResult objects.
 for(let i=0;i<max;i++){const x=fresh(RESULT);invoke(x,RESULT,'.ctor');const r=rows[i];if(r){x.set_field('_Id',r.id);x.set_field('_ValueIndex',r.index);x.set_field('_SkillId',r.skill);}a.call('SetValue(System.Object, System.Int32)',x,i);}
 invoke(e,INVENTORY,'setCustomBuildup(snow.data.EquipmentInventoryData.CustomBuildupResult[], System.SByte, System.Boolean)',a,mode,false);
 if(e.call('checkCustomBuildUpCheat')!==false||e.call('checkCustomValid')!==true)throw new Error('累计结果未通过原生炼化检查');
 if(canonical(quriousRows(e))!==canonical(rows))throw new Error('原生炼化写入回读不一致');
}
function list(o:REManagedObject):REManagedObject[]{const out:REManagedObject[]=[];const n=o.call('get_Count') as number;for(let i=0;i<n;i++)out.push(obj(o.call('get_Item',i)));return out;}
export function armorView(e:REManagedObject):ArmorView {
 const a=obj(e.call('getArmorData'));
 const slots=list(obj(e.call('getDecorationsSlotList'))).map(x=>x.call('get_SlotLv') as number);
 const skills=list(obj(a.call('get_ActiveSkillDataList'))).map(x=>({id:x.call('get_EquipSkillId') as number,name:x.call('get_Name') as string,level:a.call('getEquipSkillLevel',x.call('get_EquipSkillId')) as number}));
 const resistance=[0,1,2,3,4].map(i=>obj(a.call('getRegData',i)).call('get_RegVal') as number);
 return {defense:a.call('getDefVal') as number,slots,skills,resistance};
}
interface Effect { key:string; value:number; label:string; row:QuriousRow }
function effect(row:QuriousRow,tableNo:number):Effect {
 const data=obj(invoke(null,'snow.data.CustomBuildupModule','getBuildupData',row.id,tableNo));
 const x=fresh(RESULT);invoke(x,RESULT,'.ctor');x.set_field('_Id',row.id);x.set_field('_ValueIndex',row.index);x.set_field('_SkillId',row.skill);
 const d=fresh('snow.data.CustomBuildupResultData');invoke(d,'snow.data.CustomBuildupResultData','.ctor',data,x);
 const category=d.call('get_CategoryId') as number;let key=String(category),label='';
 if(category===13)label='防御';
 else if(category>=14&&category<=18){const element=d.call('get_RegElement') as number;key+=':'+element;label=['火耐性','水耐性','雷耐性','冰耐性','龙耐性'][element]??'耐性';}
 else if(category===19)label='孔位强化';
 else if(category===20){key+=':'+row.skill;const skill=fresh('snow.data.PlSkillData');invoke(skill,'snow.data.PlSkillData','.ctor(snow.data.DataDef.PlEquipSkillId)',row.skill);label=skill.call('get_Name') as string;}
 else throw new Error(`暂不支持此防具炼化类型：${category}`);
 return {key,value:d.call('get_Value') as number,label,row};
}
/** Combine equivalent native entries, preserving the exact sum of every effect.
 * The seven-entry native limit is respected; no cheat-check bypass is installed. */
function compact(rows:QuriousRow[],tableNo:number):QuriousRow[] {
 const groups:Record<string,{value:number;options:Effect[]}>={};
 for(const row of rows){const e=effect(row,tableNo);const g=groups[e.key]??(groups[e.key]={value:0,options:[]});g.value+=e.value;g.options.push(e);}
 // Native value tables provide alternative encodings for defense/resistance totals.
 const table=obj(invoke(null,'snow.data.CustomBuildupModule','getArmorData',tableNo));
 const dict=obj(table.get_field('_DataDict'));
 for(let category=13;category<=18;category++){
  if(dict.call('ContainsKey',category)!==true)continue;
  const entries=list(obj(dict.call('get_Item',category)));
  for(const data of entries){
   const id=data.get_field('_Id') as number;
   const param=obj(data.get_field('_BaseParam')),values=obj(param.get_field('_ValueTable')) as REManagedObject&{get_size():number};
   for(let index=0;index<values.get_size();index++){const e=effect({id,index,skill:0},tableNo);if(groups[e.key])groups[e.key]!.options.push(e);}
  }
 }
 const result:QuriousRow[]=[];
 for(const key of Object.keys(groups)){
  const g=groups[key]!;if(g.value===0)continue;
  let frontier:{value:number;path:QuriousRow[]}[]=[{value:0,path:[]}];const visited:Record<string,boolean>={'0':true};let solution:QuriousRow[]|null=null;
  const bound=Math.abs(g.value)+100;
  for(let depth=0;depth<7&&!solution;depth++){
   const next:typeof frontier=[];
   for(const node of frontier){for(const option of g.options){const value=node.value+option.value;if(Math.abs(value)>bound||visited[String(value)])continue;visited[String(value)]=true;const path=[...node.path,option.row];if(value===g.value){solution=path;break;}next.push({value,path});}if(solution)break;}
   frontier=next;
  }
  if(!solution)throw new Error('累计强化无法在原生结果容量内完整表达');result.push(...solution);
 }
 return result;
}
export function generateQurious(e:REManagedObject,mode:number):QuriousCandidate {
 if(!Number.isInteger(mode)||mode<0||mode>3)throw new Error('炼化方式无效');
 const a=obj(e.call('getArmorData'));if(a.call('isEnableCustom')!==true)throw new Error('此防具不支持原生傀异炼化，需要大师位防具');
 const tableNo=a.call('get_CustomTableNo') as number,cost=a.call('get_CustomCost') as number;
 // Mod stacking uses the currently effective slots/skills, so an already removed
 // skill cannot be offered again as a free negative and full slots stay full.
 const before=armorView(e);let remaining=12;
 for(const level of before.slots)remaining-=level;
 const index=Math.trunc((cost-10)/2);const seed=index>=0&&index<=5?32+mode+(3-mode)*index:18;
 const table=obj(invoke(null,'snow.data.CustomBuildupModule','getArmorData',tableNo));
 const generated=obj(table.call('createResult',cost,remaining,a.call('get_ActiveSkillDataList'),true,mode,seed)) as REManagedObject&{get_size():number};
 const newRows:QuriousRow[]=[];
 for(let i=0;i<generated.get_size();i++){const d=generated.call('get_Item',i) as REManagedObject|null;if(!d||!d.call('get_IsValid'))continue;const x=obj(d.get_field('_Result'));newRows.push({id:x.get_field('_Id') as number,index:x.get_field('_ValueIndex') as number,skill:x.get_field('_SkillId') as number});}
 if(!newRows.length)throw new Error('原生算法没有生成有效结果');
 const changes=newRows.map(r=>{const x=effect(r,tableNo);return `${x.label} ${x.value>0?'+':''}${x.value}`;});
 let stage='合并累计条目';
 try {const accumulated=[...quriousRows(e),...newRows];let rows=compact(accumulated,tableNo);stage='创建装备副本';const copy=armorCopy(e);stage='写入累计结果';
  try{writeQurious(copy,rows,mode);}catch(error){
   // Equivalent totals can have different native costs. Retain the original
   // encoding when it fits, rather than rejecting a legal native first roll.
   if(accumulated.length>7)throw error;rows=accumulated;writeQurious(copy,rows,mode);
  }
  // Existing sockets must survive unchanged, including after slot augmentation.
  for(let i=0;i<3;i++)if(copy.call('getDecoId',i)!==e.call('getDecoId',i))throw new Error('本次炼化会影响已镶嵌珠子，请先卸下');
  stage='读取装备能力';return {mode,rows,before,after:armorView(copy),changes,canAccept:true,reason:null};
 }catch(error){return {mode,rows:[],before,after:before,changes,canAccept:false,reason:`${stage}：${String(error)}`};}
}
