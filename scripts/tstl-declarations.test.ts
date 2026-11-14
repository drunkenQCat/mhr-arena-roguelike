import {createRequire}from'node:module';
import {expect,it}from'vitest';
const {checkSource}=createRequire(import.meta.url)('./check-tstl-declarations.js');
it('rejects sibling reads whose optional-chain temporaries are hoisted ahead of Lua declarations',()=>{
 expect(checkSource('const network=load(), identity={epoch:network.session_id?.()};')[0].names).toEqual(['network']);
 expect(checkSource('const cfg=read(), product=cfg?.products.find(p=>p.id===id);')[0].names).toEqual(['cfg']);
 expect(checkSource('const a=read(), b=a??fallback();')).toHaveLength(1);
});
it('allows separate declarations and independent optional initializers',()=>{
 expect(checkSource('const cfg=read();const product=cfg?.products.find(p=>p.id===id);')).toEqual([]);
 expect(checkSource('const a=read(), b=other?.read();')).toEqual([]);
 expect(checkSource('const cfg=read(), b=other?.cfg;')).toEqual([]);
});
