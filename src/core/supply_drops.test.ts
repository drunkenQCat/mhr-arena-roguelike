import {expect,it} from "vitest";
import {rollSupplyDrops} from "./supply_drops";
import {validateConfig} from "./config";
import {defaultConfig} from "../game/default_config";
it("rolls once per monster, supports disabling and never rolls equipment services",()=>{
 const spec={chance:1,entries:[{itemId:"honey",count:1,weight:1}]};let calls=0;
 expect(rollSupplyDrops(spec,2,()=>{calls++;return 0;})).toEqual([{itemId:"honey",count:1},{itemId:"honey",count:1}]);expect(calls).toBe(4);
 expect(rollSupplyDrops({...spec,chance:0},2,()=>{throw Error("no roll");})).toEqual([]);
 const cfg=validateConfig(defaultConfig);
 expect(()=>validateConfig({...cfg,supplyDrops:{chance:2,entries:spec.entries}})).toThrow();
 expect(()=>validateConfig({...cfg,supplyDrops:{chance:1,entries:[{itemId:"gacha_1",count:1,weight:1}]}})).toThrow();
});
