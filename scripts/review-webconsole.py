"""Run emitted Lua against an isolated fake game port.

For browser verification without changing a live quest:
  python scripts/review-webconsole.py --port 11877 --fixture-http
Open http://127.0.0.1:11877/console. This is NOT a live-game acceptance test.
Requires console/build, build:nocopy and lupa. The test-only Python HTTP transport
does not validate the native memory transport or real game APIs.
Control .local/console-review/control.json: {"x":200} moves the fake player;
{"freeze":true} stops Lua updates while HTTP remains available.
"""
import argparse
import json
from pathlib import Path
import shutil
import time
import threading
import queue
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from lupa.lua54 import LuaRuntime

ROOT = Path(__file__).resolve().parent.parent


def run():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=11877)
    parser.add_argument("--seconds", type=int, default=1200)
    parser.add_argument("--fixture-http", action="store_true", help="Compatibility flag; this preview always uses isolated fixture HTTP")
    args = parser.parse_args()
    folder = ROOT / ".local/console-review"
    data = folder / "testdata"
    data.mkdir(parents=True, exist_ok=True)
    shutil.copy2(ROOT / "console/dist/index.html", folder / "console.html")
    (folder / "control.json").write_text("{}", encoding="utf-8")
    commands = queue.Queue(maxsize=32)
    published = {}
    lock = threading.Lock()

    def publish(kind, text):
        with lock:
            published[kind] = text.encode("utf-8")

    def take_command():
        try:
            return commands.get_nowait()
        except queue.Empty:
            return None
    lua = LuaRuntime(unpack_returned_tuples=True)

    def to_python(value):
        if hasattr(value, "items"):
            entries = dict(value.items())
            if not entries:
                return None  # Match REFramework's empty-table encoder.
            if set(entries) == set(range(1, len(entries) + 1)):
                return [to_python(entries[i]) for i in range(1, len(entries) + 1)]
            return {str(k): to_python(v) for k, v in entries.items()}
        return value

    def encode(value, indent=-1):
        return json.dumps(to_python(value), ensure_ascii=False, separators=(",", ":"))

    def write(path, text):
        (data / path).write_text(text, encoding="utf-8")

    def read(path):
        p = data / path
        return p.read_text(encoding="utf-8") if p.exists() else ""

    def dump(path, value, indent=-1):
        body = to_python(value)
        if path == "webconsole_state.json" and isinstance(body, dict):
            body["testMode"] = True
        write(path, json.dumps(body, ensure_ascii=False, separators=(",", ":")))
        return True

    def decode(text):
        try:
            return lua.table_from(json.loads(text), recursive=True)
        except (json.JSONDecodeError, TypeError):
            return None

    lua.globals().json = lua.table_from({"dump_file": dump, "dump_string": encode,
        "load_string": decode, "load_file": lambda p: decode(read(p))})
    lua.globals().fs = lua.table_from({"read": read, "write": write})
    lua.globals().fixture_take_command = take_command
    lua.globals().fixture_publish = publish
    lua.execute("""
      package.preload['webconsole']=function() return {
        epoch=function() return 1 end,
        take_commands=function()
          local cmd=fixture_take_command()
          return cmd and {cmd} or {}
        end,
        publish_state=function(text) local state=json.load_string(text);state.testMode=true;fixture_publish('state',json.dump_string(state)) end,
        publish_results=function(text) fixture_publish('results',text) end
      } end
      local inventory = {}
      local pouch = {get_type_definition=function() return {get_method=function() return {} end} end}
      function pouch:call(method, id, count)
        if method=='findInventoryData' then
          return {call=function(_, m) if m=='get_Count' then return inventory[id] or 0
            elseif m=='getRemainingCount' then return 99-(inventory[id] or 0) elseif m=='isFull' then return false end end}
        elseif method=='canAddItem' then return true
        elseif method:find('tryAddGameItem') then inventory[id]=(inventory[id] or 0)+count end
      end
      source = {time=0,quest=nil,players={{id=0,position={x=10,y=20,z=30}}},enemies={},deaths=0,online=false,canPost=true}
      local qm={call=function(_, m)
        if m=='isActiveQuest' then return source.quest~=nil elseif m=='isPlayQuest' then return source.quest and source.quest.playing
        elseif m=='get_ActiveQuestNo' then return source.quest and source.quest.id
        elseif m=='getActiveQuestUniqueNo' then return source.quest and source.quest.unique end end}
      sdk={PreHookResult={},get_managed_singleton=function(name)
        if name=='snow.QuestManager' then return qm
        elseif name=='snow.stage.StageManager' then return {call=function() return false end}
        elseif name=='snow.gui.GuiManager' then return {call=function(_,m) return m=='IsCanInvokeQuestBoard' end}
        elseif name=='snow.enemy.EnemyManager' then return {call=function(_,m,i)
          if m=='getBossEnemyCount' then return #source.enemies end
          local enemy=source.enemies[i+1]; return {call=function(_,method)
            if method=='isDieBehaviorActive' then return enemy.dead elseif method=='isCapture' then return enemy.captured end end}
          end}
        elseif name=='snow.data.DataManager' then return {get_field=function() return pouch end} end
      end}
      re={}; imgui={}; thread={}; log={info=function()end,warn=function()end,error=function()end}
    """)
    bundle = (ROOT / "reframework/autorun/mhw_rogue.lua").read_text(encoding="utf-8")
    entry = 'local ____entry = require("src.game.main", ...)\nreturn ____entry'
    assert bundle.count(entry) == 1
    bundle = bundle.replace(entry, """return {
      RunCore=require('src.core.run_core').RunCore,
      RunSession=require('src.core.run_session').RunSession,
      validateConfig=require('src.core.config').validateConfig,
      defaults=require('src.game.default_config'),
      ShopWindow=require('src.game.shop_window').ShopWindow,
      Bridge=require('src.game.webconsole_bridge').WebConsoleBridge
    }""")
    lua.globals().modules = lua.execute(bundle)
    lua.execute("""
      function new(Class, ...) local x=setmetatable({},Class.prototype);x:____constructor(...);return x end
      function clone(t) if type(t)~='table' then return t end local r={} for k,v in pairs(t) do r[k]=clone(v) end return r end
      cfg=modules.validateConfig(nil,modules.defaults.defaultConfig)
      cfg.runtime.route='inPlace';cfg.runtime.carveSeconds=2;cfg.runtime.campDwellSeconds=1
      core=new(modules.RunCore,cfg,42)
      local nextUid=100
      local port={ready=function()return true end,now=function()return os.time()end,
        read=function()source.time=os.time();return clone(source)end,
        publish=function(_,plan)
          source.enemies={};for _,id in ipairs(plan.monsterIds) do nextUid=nextUid+1;table.insert(source.enemies,{uid=nextUid,typeId=id,dead=false,captured=false})end end,
        policy=function()end,post=function()source.quest={id=cfg.quest.id,unique=42,playing=true,status='play'};source.canPost=false end,
        cancelPost=function()end,postingError=function()return nil end,
        finish=function()source.quest=nil;source.enemies={};source.canPost=true end,
        takeDeaths=function()return {} end,report=function()end}
      session=new(modules.RunSession,core,modules.defaults.monsterCatalog,port)
      tools={invincible=false,message='TEST HARNESS: no live game'}
      function tools:toggleGod() self.invincible=not self.invincible end
      function tools:requestKill() for _,e in ipairs(source.enemies) do e.dead=true end end
      runtime={ready=function()return true end,status=function()return 'ISOLATED TEST: emitted Lua, simulated native game API' end,testTools=tools}
      shop=new(modules.ShopWindow,core,function()return session:canShop()end,function()return session:shopQuest()end)
      bridge=new(modules.Bridge,session,runtime,shop)
      function frame(x)
        source.players[1].position.x=x or 10
        session:tick();shop:tick();bridge:tick()
      end
    """)
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_): pass

        def reply(self, status, body, content_type="application/json; charset=utf-8"):
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if self.path == '/console':
                self.reply(200, (folder / 'console.html').read_bytes(), 'text/html; charset=utf-8')
                return
            if self.path == '/api/health':
                self.reply(200, b'{"ok":true,"protocol":4,"testMode":true}')
                return
            kind = {'/api/state': 'state', '/api/results': 'results'}.get(self.path)
            with lock:
                body = published.get(kind)
            self.reply(200 if body else 503, body or b'{"error":"fixture state not ready"}')

        def do_POST(self):
            if self.path != '/api/command': self.send_error(404); return
            try:
                size = int(self.headers.get('Content-Length', '0'))
                if not 0 < size <= 65536: raise ValueError("invalid size")
                body = self.rfile.read(size).decode('utf-8')
                command = json.loads(body)
                if not isinstance(command, dict) or not command.get('id'): raise ValueError("missing id")
                commands.put_nowait(body)
            except queue.Full:
                self.reply(429, b'{"error":"fixture queue full"}'); return
            except (ValueError, UnicodeError):
                self.reply(400, b'{"error":"invalid fixture command"}'); return
            self.reply(200, b'{"ok":true,"queued":true}')

    server = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    print(f"ISOLATED FIXTURE (not a game): http://127.0.0.1:{args.port}/console", flush=True)
    print(f"Control file: {folder / 'control.json'}", flush=True)
    deadline = time.monotonic() + args.seconds
    try:
        while time.monotonic() < deadline:
            try:
                control = json.loads((folder / "control.json").read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                control = {}
            if not control.get("freeze"):
                lua.globals().frame(control.get("x", 10))
            time.sleep(1 / 60)
    finally:
        server.shutdown(); server.server_close()


if __name__ == "__main__":
    run()
