import { beforeEach, expect, it, vi } from "vitest";
const h=vi.hoisted(()=>({context:true,objects:[] as any[],manager:null as any,wrong:false}));
function arr(values:any[]){return {get_size:()=>values.length,get_field:()=>null,call:(m:string,i:number,v:any)=>m==="get_Count"?values.length:m==="get_Item"?values[i]:m==="set_Item"?(values[i]=v):null,values};}
function obj(values:Record<string,any>){return {get_field:(k:string)=>values[k],set_field:(k:string,v:any)=>values[k]=v,
 get_address:()=>values.address,add_ref:vi.fn(),values,call:(m:string)=>m==="get_Name"?values._Name:null};}
function tint(){return obj({_IsEnable:false,_IsDefault:true,_Color:obj({x:0,y:0,z:0})});}
function fresh(){return obj({_InventoryIndexList:arr(new Array(8).fill(-1)),"<InventoryDataList>k__BackingField":arr(new Array(8).fill(null)),
 _Name:"",_IsUsing:true,_ActionIdList:arr([1,2,3]),_ActionIdListMR_Red:arr([1,2,3,4,5]),_ActionIdListMR_Blue:arr([1,2,3,4,5]),
 _BackupDataList:arr(Array.from({length:8},()=>obj({IdVal:-1,InsectIdVal:-1,InsectInventoryIndex:-1,BowgunCustomizeType:0,HyakuryuDecoId:0,
 DecoIdList:arr([0,0,0]),HyakuryuColorData:tint(),SymbolColorSet:obj({_ColorData:arr([tint(),tint()])})})))});}
const entries=Array.from({length:8},(_,i)=>obj({address:i+10,_IdType:i===6?5:2,_IdVal:100+i}));
const weaponBox = arr(entries.filter((_v,i)=>i!==6));
const cageBox = arr([entries[6]]);
function resolve(o:any){
 for(let i=0;i<8;i++)o.values["<InventoryDataList>k__BackingField"].values[i]=o.values._InventoryIndexList.values[i]===-1?null:entries[i];}
vi.mock("./equipment_update",()=>({requireEquipmentUpdate:()=>{if(!h.context)throw new Error("wrong thread");},retainEquipmentObject:vi.fn()}));
vi.mock("./sdk",()=>({rejson:{dump_string:JSON.stringify},createInstance:()=>{const o=fresh();h.objects.push(o);return o;},createManagedString:(s:string)=>s,
 getSingleton:()=>obj({_PlEquipBox:obj({_WeaponArmorInventoryList:weaponBox,_LvBuffCageInventoryList:cageBox})}),
 findTypeDefinition:()=>({get_method:()=>({})}),callNativeFunction:(o:any,_t:unknown,m:string,...args:any[])=>{
 if(m.startsWith("registerEquipMySet")){
  const x=args[0];x.values._InventoryIndexList.values.splice(0,8,...h.manager.values.pack.values._InventoryIndexList.values);
  for(let i=0;i<8;i++)x.values._BackupDataList.values[i].values.IdVal=x.values._InventoryIndexList.values[i]===-1?-1:100+i;
  resolve(x);
 }
 if(m==="restoreVariableToRef")resolve(o);
 if(m.startsWith("applyEquipMySet")){
  if(!h.wrong)h.manager.values.pack=args[0];return true;
 }
 return null;
 }}));
import { applyEquipmentIndices, applyEquipmentMySet, captureEquipmentMySet, validateEquipmentMySet } from "./native_equipment_myset";
beforeEach(()=>{h.context=true;h.objects=[];h.wrong=false;const p=fresh();p.values._InventoryIndexList.values.splice(0,8,0,1,2,3,4,5,0,-1);resolve(p);
 h.manager=obj({pack:p});h.manager.call=(m:string)=>m==="get_PlEquipPack"?h.manager.values.pack:null;});
it("captures an independent, serializable native preset, then reconstructs a fresh one on every restore",()=>{
 const original=captureEquipmentMySet(h.manager);const before=structuredClone(original);
 applyEquipmentIndices(h.manager,[0,-1,2,3,4,5,0,-1]);expect(h.manager.values.pack.values["<InventoryDataList>k__BackingField"].values[1]).toBeNull();
 applyEquipmentMySet(h.manager,original);const first=h.objects.at(-1);applyEquipmentMySet(h.manager,original);
 expect(h.objects.at(-1)).not.toBe(first);expect(original).toEqual(before);
 expect(h.manager.values.pack.values["<InventoryDataList>k__BackingField"].values[6]).toBe(entries[6]);
});
it("does not accept a native success return while actual equipment stayed unchanged",()=>{
 const original=captureEquipmentMySet(h.manager);applyEquipmentIndices(h.manager,[0,-1,2,3,4,5,0,-1]);h.wrong=true;
 expect(()=>applyEquipmentMySet(h.manager,original)).toThrow("不一致");
});
it("rejects malformed saved arrays before native allocation and rejects the render context",()=>{
 const original=captureEquipmentMySet(h.manager);const n=h.objects.length;original._ActionIdListMR_Blue=[];
 expect(()=>applyEquipmentMySet(h.manager,original)).toThrow("无效");expect(h.objects).toHaveLength(n);
 h.context=false;expect(()=>captureEquipmentMySet(h.manager)).toThrow("wrong thread");
});

it("preflights corrupt native inventory indices before constructing or resolving a saved set",()=>{
 const original=captureEquipmentMySet(h.manager),n=h.objects.length;original.indices[1]=9999;
 expect(()=>applyEquipmentMySet(h.manager,original)).toThrow("越界");expect(h.objects).toHaveLength(n);
});
