import {readFileSync,existsSync} from 'node:fs';
import {expect,it} from 'vitest';
import assets from './release-files.json';
import catalog from '../data/effect_catalog.json';
it('ships exactly the declared effect catalog and modules while excluding probes and the experiment fixture',()=>{
 const runtime=assets.filter(a=>a.destination.startsWith('reframework/data/rogue_effects/'));
 expect(runtime.map(a=>a.destination.slice('reframework/data/'.length)).sort()).toEqual([...catalog.modules].sort());
 expect(assets.find(a=>a.destination==='reframework/data/rogue_effect_catalog.json')?.source).toBe('data/effect_catalog.json');
 for(const asset of runtime){
   expect(asset.root).toBe('repo');expect(existsSync(new URL(`../${asset.source}`,import.meta.url))).toBe(true);
   expect(readFileSync(new URL(`../${asset.source}`,import.meta.url),'utf8')).toContain('definition');
 }
 expect(assets.some(a=>/autorun-probe|effect_demo|webconsole_runs|\.log$/.test(a.source))).toBe(false);
});
