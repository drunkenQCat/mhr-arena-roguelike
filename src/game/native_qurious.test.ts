import {describe,it,expect,vi} from 'vitest';
const h=vi.hoisted(()=>({arrays:[] as any[],writes:0,invalid:false}));
vi.mock('./equipment_update',()=>({retainEquipmentObject:()=>{}}));
vi.mock('./sdk',()=>({
 rejson:{dump_string:JSON.stringify},
 findTypeDefinition:(name:string)=>({name}),
 createInstance:()=>({fields:{} as Record<string,number>,set_field(name:string,value:number){this.fields[name]=value},get_field(name:string){return this.fields[name]??0},call(name:string){if(name==='isValied')return (this.fields._Id??0)>0}}),
 createManagedArray:(_name:string,size:number)=>{const array={values:Array(size).fill(null),get_size(){return size},call(method:string,...args:any[]){if(method.startsWith('SetValue'))this.values[args[1]]=args[0];else if(method==='get_Item')return this.values[args[0]]}};h.arrays.push(array);return array},
 callNativeFunction:(o:any,_type:any,name:string,...args:any[])=>{
  if(name==='get_CustomBuildupResultMax')return 7;
  if(name==='setCustomStartup')o.enabled=true;
  if(name.startsWith('setCustomBuildup(')){expect(args[0].values).toHaveLength(7);expect(args[0].values.every(Boolean)).toBe(true);o.rows=args[0];h.writes++;}
 },
}));
import {writeQurious} from './native_qurious';
function equipment(){return {enabled:false,rows:null as any,call(name:string){if(name==='get_CustomEnable')return this.enabled;if(name==='get_CustomBuildup')return this.rows;if(name==='checkCustomBuildUpCheat')return h.invalid;if(name==='checkCustomValid')return true}} as any;}
describe('native augmentation boundary',()=>{
 it('initializes every native result entry, including unused capacity, and reads back exact rows',()=>{
  const e=equipment();writeQurious(e,[{id:69,index:0,skill:0}],0);
  expect(e.enabled).toBe(true);expect(e.rows.values.filter((x:any)=>x.call('isValied'))).toHaveLength(1);
 });
 it('rejects overflow before enabling or writing an equipment instance',()=>{
  const e=equipment(),writes=h.writes;
  expect(()=>writeQurious(e,Array(8).fill({id:69,index:0,skill:0}),0)).toThrow('最多容纳');expect(e.enabled).toBe(false);expect(h.writes).toBe(writes);
 });
 it('refuses native validation failure',()=>{
  h.invalid=true;try{expect(()=>writeQurious(equipment(),[{id:69,index:0,skill:0}],0)).toThrow('未通过');}finally{h.invalid=false;}
 });
});
