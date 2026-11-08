import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
vi.mock("./sdk",()=>({loadWebconsole:()=>({steam_digest:(s:string)=>createHash("sha256").update(s).digest("hex")}),
 rejson:{dump_string:JSON.stringify}}));
import { captureEquipmentBox, equipmentFingerprint, verifyEquipmentBox, validateEquipmentSnapshot } from "./equipment_snapshot";
function object(fields:Record<string,any>):any {return {fields,get_field:(n:string)=>fields[n]};}
function array(values:any[]):any {return {values,get_size:()=>values.length,get_element:()=>({boxed:true}),call:(_n:string,i:number)=>values[i]};}
function equip(type=1,id=135266324) {
 const fields:Record<string,any>={_IdType:type,_IdVal:id,_BowgunCustomizeType:0,_PairInsectInventoryIndex:-1,_HyakuryuModelId:0,
  _BuildupPoint:0,_CustomCount:0,_CustomBuildupType:0,_HyakuryuDecoId:0,_IsSetGuildCard:false,_IsLock:false,_CustomEnable:false,
  _HyakuryuColorData:object({_IsEnable:false,_IsDefault:true,_Color:object({x:0,y:0,z:0})}),
  _CustomBuildup:array([object({_Id:0,_ValueIndex:0,_SkillId:0})])};
 for(const f of ["_HyakuryuSkillIdList","_PrevHyakuryuSkillId","_TalismanDecoSlotNumList","_TalismanSkillIdList","_TalismanSkillLvList","_CustomOpenIdArray","_DecoIdList"])fields[f]=array([0]);
 return object(fields);
}
function fixture() {
 const entries=[equip(),equip(0,0),equip(0,0)];
 const box=object({_WeaponArmorInventoryList:{call:(n:string,i:number)=>n==="get_Count"?entries.length:entries[i]}});
 const original=captureEquipmentBox(box);entries[1]=equip(2,201326601);
 const grant={boxIndex:1,idType:2,idVal:201326601,fingerprint:equipmentFingerprint(entries[1])};
 return {entries,box,original,grant};
}
it("fingerprints saved augments, slots, colors and customization rather than addresses or sort caches",()=>{
 const e=equip(),original=equipmentFingerprint(e);
 e.fields._SortValue1=999;e.get_address=()=>999;expect(equipmentFingerprint(e)).toBe(original);
 const changes=[()=>{e.fields._CustomCount++;},()=>{e.fields._DecoIdList.values[0]++;},
  ()=>{e.fields._CustomBuildup.values[0].fields._ValueIndex++;},()=>{e.fields._HyakuryuColorData.fields._Color.fields.x++;},
  ()=>{e.fields._BowgunCustomizeType++;},()=>{e.fields._TalismanSkillIdList.values[0]++;}];
 for(const change of changes){const previous=equipmentFingerprint(e);change();expect(equipmentFingerprint(e)).not.toBe(previous);}
});
it("verifies an entire unchanged original box and recorded temporary pieces across relocation",()=>{
 const f=fixture();expect(()=>verifyEquipmentBox(f.box,f.original,[f.grant])).not.toThrow();
 f.entries[1]=equip(0,0);expect(()=>verifyEquipmentBox(f.box,f.original,[{...f.grant,removed:true}])).not.toThrow();
});
it("rejects same-ID modified originals, modified temporary items and untracked additions",()=>{
 const a=fixture();a.entries[0].fields._CustomCount=1;
 expect(()=>verifyEquipmentBox(a.box,a.original,[a.grant])).toThrow("Original equipment changed");
 const b=fixture();b.entries[1].fields._DecoIdList.values[0]=100;
 expect(()=>verifyEquipmentBox(b.box,b.original,[b.grant])).toThrow("Unverified equipment");
 const c=fixture();c.entries[2]=equip();expect(()=>verifyEquipmentBox(c.box,c.original,[c.grant])).toThrow("Unverified equipment");
});
it("never guesses ownership of an unconfirmed grant, a recycled cleaned slot or a conflicting reservation",()=>{
 const f=fixture();expect(()=>verifyEquipmentBox(f.box,f.original,[{...f.grant,fingerprint:undefined}])).toThrow();
 expect(()=>verifyEquipmentBox(f.box,f.original,[{...f.grant,removed:true}])).toThrow();
 expect(()=>verifyEquipmentBox(f.box,f.original,[f.grant,f.grant])).toThrow("reservation conflicts");
});
it("distinguishes an originally empty native JSON object from a lost nonempty snapshot",()=>{
 expect(()=>validateEquipmentSnapshot({capacity:3,originalCount:0,entries:null as any})).not.toThrow();
 expect(()=>validateEquipmentSnapshot({capacity:3,originalCount:1,entries:null as any})).toThrow("incomplete");
 const e=equip();delete e.fields._CustomCount;expect(()=>equipmentFingerprint(e)).toThrow("field unavailable");
});
