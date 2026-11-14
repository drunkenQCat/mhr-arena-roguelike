import {expect,it} from 'vitest';
import raw from '../../data/rogue_config.json';
import demo from '../../data/effect_demo.json';
import {validateConfig} from './config';
const input=()=>({...structuredClone(raw),effectShop:structuredClone(demo)}) as any;
it('normalizes nullable empty collections from the native JSON binding before product validation',()=>{
 const c=input();c.effectShop.products[0].conditions.weapons=null;c.effectShop.products[0].conditions.exclusiveGroups=null;
 expect(validateConfig(c).effectShop!.products[0]!.conditions).toMatchObject({weapons:[],exclusiveGroups:[]});
 c.effectShop={groups:null,products:null};expect(validateConfig(c).effectShop).toEqual({groups:{},products:[]});
});
it.each([
 ['duplicate legacy shop ID',(c:any)=>{c.effectShop.products[0].id=c.Shop[0].Id;}],
 ['fractional price',(c:any)=>{c.effectShop.products[0].price=1.5;}],
 ['bad phase',(c:any)=>{c.effectShop.products[0].conditions.phases=['Finished'];}],
 ['bad native weapon enum',(c:any)=>{c.effectShop.products[0].conditions.weapons=[14];}],
 ['unknown exclusive group',(c:any)=>{c.effectShop.products[0].conditions.exclusiveGroups=['missing'];}],
 ['negative quota',(c:any)=>{c.effectShop.products[0].conditions.limit={count:-1,scope:'teamRun'};}],
])('rejects malformed effect settings: %s',(_name,change)=>{const c=input();change(c);expect(()=>validateConfig(c)).toThrow();});
