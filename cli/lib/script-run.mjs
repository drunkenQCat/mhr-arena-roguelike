import { randomUUID } from 'node:crypto';
import luaparse from 'luaparse';

// A private require proxy is captured by this chunk's asynchronous callbacks.
// Never replace the process-wide webconsole publisher or Lua require function.
export function scriptPayload(file, content) {
  const script = file.split(/[\\/]/).pop();
  if (!/^[\w.-]+\.lua$/.test(script ?? '')) throw new Error('A safe .lua filename is required');
  const executionId = randomUUID();
  if (content !== null) luaparse.parse(content, { luaVersion: '5.3' });
  else if (!/^[\w./-]+\.lua$/.test(file) || file.startsWith('/') || file.split('/').includes('..'))
    throw new Error('A relative game-tree .lua path is required');
  const body = content ?? `local f,e=loadfile(${JSON.stringify(file)},"t",setmetatable({require=require},{__index=_G})); if not f then error(e) end; return f()`;
  const wrapped = `local __mhr_wc=require("webconsole")
local __mhr_require_original=require
local __mhr_execution_id=${JSON.stringify(executionId)}
local __mhr_proxy=setmetatable({publish_probe=function(text)
 local r=json.load_string(text); assert(type(r)=="table","probe report must be an object")
 r.executionId=__mhr_execution_id
 __mhr_wc.publish_probe(json.dump_string(r))
end},{__index=__mhr_wc})
local function __mhr_body(require)
${body}
end
local ok,err=pcall(__mhr_body,function(name)
 if name=="webconsole" then return __mhr_proxy end
 return __mhr_require_original(name)
end)
if not ok then __mhr_proxy.publish_probe(json.dump_string({kind="run_script",script=${JSON.stringify(script)},epoch=__mhr_wc.epoch(),verdict="ERROR",error=tostring(err)})) end
`;
  return { script, executionId, payload: { name: `exec-${executionId}.lua`, content: wrapped } };
}

export function isExecutionReport(report, script, epoch, executionId) {
  return report?.script === script && report?.epoch === epoch && report?.executionId === executionId;
}
