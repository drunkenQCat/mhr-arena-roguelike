import {readFileSync} from 'node:fs';
import {expect,it} from 'vitest';
import {transpileString,LuaTarget} from 'typescript-to-lua';

it('does not emit a partial Lua artifact when TSTL reports an unsupported construct',()=>{
 const config=JSON.parse(readFileSync(new URL('../tsconfig.json',import.meta.url),'utf8'));
 expect(config.compilerOptions.noEmitOnError).toBe(true);
 const result=transpileString('export const unsupported = /not-supported-in-lua/;',{
  noEmitOnError:config.compilerOptions.noEmitOnError,luaTarget:LuaTarget.Lua54,
 });
 expect(result.diagnostics.some(d=>String(d.messageText).includes('Unsupported node kind'))).toBe(true);
 expect(result.file).toBeUndefined();
 const valid=transpileString('export const supported = 1;',{
  noEmitOnError:config.compilerOptions.noEmitOnError,luaTarget:LuaTarget.Lua54,
 });
 expect(valid.file).toBeDefined();
});
