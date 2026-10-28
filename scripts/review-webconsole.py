"""Run emitted Lua + the real native HTTP server against an isolated fake game port.

For browser verification without changing a live quest:
  python scripts/review-webconsole.py --port 11877
Open http://127.0.0.1:11877/console. This is NOT a live-game acceptance test.
Requires console/build, build:nocopy, native build-standalone and lupa.
Control .local/console-review/control.json: {"x":200} moves the fake player;
{"freeze":true} stops Lua updates while HTTP remains available.
"""
import argparse
import json
from pathlib import Path
import shutil
import subprocess
import time
from lupa.lua54 import LuaRuntime

ROOT = Path(__file__).resolve().parent.parent


def run():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=11877)
    parser.add_argument("--seconds", type=int, default=1200)
    args = parser.parse_args()
    folder = ROOT / ".local/console-review"
    data = folder / "testdata"
    data.mkdir(parents=True, exist_ok=True)
    shutil.copy2(ROOT / "native/webconsole/webconsole_test.exe", folder / "webconsole_test.exe")
    shutil.copy2(ROOT / "console/dist/index.html", folder / "console.html")
    (folder / "control.json").write_text("{}", encoding="utf-8")
    (data / "webconsole_cmd.json").write_text("{}", encoding="utf-8")
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
    lua.execute("""
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
      runtime={status=function()return 'ISOLATED TEST: emitted Lua, simulated native game API' end,testTools=tools}
      shop=new(modules.ShopWindow,core,function()return session:canShop()end,function()return session:shopQuest()end)
      bridge=new(modules.Bridge,session,runtime,shop)
      function frame(x)
        source.players[1].position.x=x or 10
        session:tick();shop:tick();bridge:tick()
      end
    """)
    process = subprocess.Popen([str(folder / "webconsole_test.exe"), str(args.port)], cwd=folder,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    print(f"Isolated Lua + native HTTP preview: http://127.0.0.1:{args.port}/console", flush=True)
    print(f"Control file: {folder / 'control.json'}", flush=True)
    deadline = time.monotonic() + args.seconds
    try:
        while time.monotonic() < deadline and process.poll() is None:
            try:
                control = json.loads((folder / "control.json").read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                control = {}
            if not control.get("freeze"):
                lua.globals().frame(control.get("x", 10))
            time.sleep(1 / 60)
    finally:
        process.terminate()
        process.wait(timeout=5)


if __name__ == "__main__":
    run()
