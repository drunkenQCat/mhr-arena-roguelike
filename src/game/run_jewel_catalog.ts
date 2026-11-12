import { createInstance, callNativeFunction, findTypeDefinition } from "./sdk";
const names:Record<string,string>={};
const levels:Record<string,number>={};
export function runJewelLevel(id:number):number { runJewelName(id);return levels[String(id)]!; }
/** Validate enum membership before constructing native catalogue objects. */
export function runJewelName(id:number):string {
  if(!Number.isInteger(id)||id<=0)throw new Error("珠子 ID 无效");
  if(names[String(id)])return names[String(id)]!;
  const enumeration=findTypeDefinition("snow.equip.DecorationsId") as unknown as {
    get_fields():{is_static():boolean;get_data(o:unknown):unknown}[]
  }|null;
  if(!enumeration?.get_fields().some(f=>f.is_static()&&f.get_data(null)===id))throw new Error(`游戏不支持此珠子 ID：${id}`);
  const type=findTypeDefinition("snow.data.DecorationsData"), object=createInstance("snow.data.DecorationsData");
  if(!type||!object)throw new Error("原生珠子目录不可用");
  object.add_ref();callNativeFunction(object,type,".ctor(snow.equip.DecorationsId)",id);
  const level=object.call("getCommonDecoLv"),name=object.call("getName");
  if(object.call("isHyakuryu")!==false||typeof level!=="number"||level<1||level>4||typeof name!=="string"||!name)
    throw new Error("本局只支持原生合法的普通装饰品");
  names[String(id)]=name;levels[String(id)]=level;return name;
}
