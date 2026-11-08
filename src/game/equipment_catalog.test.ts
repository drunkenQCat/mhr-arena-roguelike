import { beforeEach, expect, it, vi } from "vitest";
import { validateConfig } from "../core/config";
import { defaultConfig } from "./default_config";
const h = vi.hoisted(() => ({ range:true, present:true, available:true, fail:false, actualId:null as number|null, calls:[] as string[] }));
vi.mock("./sdk", () => ({findTypeDefinition:() => h.available ? {get_method:(name:string) => ({
  call:(_self:unknown,id:number) => {
    h.calls.push(`${name}:${id}`);
    if (h.fail) throw new Error("data unavailable");
    return name.startsWith("isValid(") ? h.range : h.present ? {call:()=>h.actualId??id} : null;
  }
})} : null}));
import { equipmentUnavailableReason, validateEquipmentConfig } from "./equipment_catalog";
beforeEach(()=>{h.range=true;h.present=true;h.available=true;h.fail=false;h.actualId=null;h.calls=[];});
it("requires both the installed ID range and a loaded equipment definition",()=>{
  expect(equipmentUnavailableReason("weapon",0x100000000+139461048)).toContain("32 位");
  expect(h.calls).toEqual([]); // Native argument truncation must not turn this into a valid weapon.
  expect(equipmentUnavailableReason("armor",202375177)).toBeNull();
  expect(h.calls).toEqual(["isValid(snow.data.DataDef.PlArmorId):202375177","getArmorBaseData(snow.data.DataDef.PlArmorId):202375177"]);
  h.calls=[];h.range=false;
  expect(equipmentUnavailableReason("armor",0x0c1fffff)).toContain("游戏不支持");
  expect(h.calls).toHaveLength(1); // Do not call a native data lookup for an out-of-range series.
  h.range=true;h.present=false;
  expect(equipmentUnavailableReason("weapon",139461048)).toContain("没有对应数据");
  h.present=true;h.actualId=139461049;
  expect(equipmentUnavailableReason("weapon",139461048)).toContain("返回了不同 ID");
});
it("fails closed on unavailable APIs and native lookup errors without caching a transient failure",()=>{
  h.available=false;expect(equipmentUnavailableReason("armor",202375177)).toContain("接口不可用");
  h.available=true;h.fail=true;expect(equipmentUnavailableReason("armor",202375177)).toContain("目录读取失败");
  h.fail=false;expect(equipmentUnavailableReason("armor",202375177)).toBeNull();
});
it("reports the exact configuration path and checks every startup part before any proposal is saved",()=>{
  const cfg=validateConfig(structuredClone(defaultConfig));
  validateEquipmentConfig(cfg);
  for(let part=1;part<=5;part++) expect(h.calls).toContain(`isValid(snow.data.DataDef.PlArmorId):${0x0c000000+part*0x100000+cfg.armorSets![cfg.armorOptions[0]!]!.series}`);
  h.range=false;expect(()=>validateEquipmentConfig({...cfg,armorOptions:[],gachaPools:{bad:{entries:[{kind:"weapon",id:139461048,w:1}]}}})).toThrow("gachaPools.bad.entries[0].id");
  expect(()=>validateEquipmentConfig({...cfg,armorSets:{}})).toThrow("请先定义初始防具套装");
});
