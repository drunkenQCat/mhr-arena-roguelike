"""Two OS processes running the emitted Lua business code over real loopback HTTP.

This tests process isolation and the lobby-metadata protocol, not Rise engine
replication, Steam authentication, or native item delivery. Requires lupa 2.8.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parent.parent
ENTRY = 'local ____entry = require("src.game.main", ...)\nreturn ____entry'


def worker(role, base):
    from lupa.lua54 import LuaRuntime
    lua = LuaRuntime(unpack_returned_tuples=True)

    def plain(value):
        if hasattr(value, 'items'):
            entries = list(value.items())
            if entries and all(isinstance(k, int) for k, _ in entries):
                return [plain(value[i]) for i in range(1, len(entries) + 1)]
            return {str(k): plain(v) for k, v in entries}
        return value

    def request(path, body=None):
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(base + path, data=data, headers={'Content-Type': 'application/json'})
        with urllib.request.urlopen(req, timeout=5) as response:
            return json.load(response)

    lua.globals().wire_dump = lambda value, *_: json.dumps(plain(value), ensure_ascii=False, separators=(',', ':'))
    lua.globals().wire_load = lambda value: lua.table_from(json.loads(value), recursive=True)
    lua.globals().wire_hash = lambda text: hashlib.sha256(text.encode()).hexdigest()
    lua.globals().net_snapshot = lambda: lua.table_from(request('/snapshot?peer=' + role), recursive=True)
    lua.globals().net_plan = lambda lobby, text: request('/plan', {'peer': role, 'value': text})['ok']
    lua.globals().net_ack = lambda lobby, text: request('/ack', {'peer': role, 'value': text})['ok']
    lua.globals().peer_role = role
    lua.execute('''
      clock=100; os.time=function() return clock end
      log={info=function() end,warn=function() end,error=function() end}
      json={dump_string=wire_dump,load_string=wire_load}
      thread={get_hook_storage=function() return {} end}
      sdk={PreHookResult={CALL_ORIGINAL=0,SKIP_ORIGINAL=1}}; re={};fs={};imgui={}
    ''')
    bundle = (ROOT / 'reframework/autorun/mhw_rogue.lua').read_text(encoding='utf-8')
    assert bundle.count(ENTRY) == 1
    lua.globals().m = lua.execute(bundle.replace(ENTRY, '''
      ____moduleCache["src.game.multiplayer_scope"]={value={multiplayerScope=function() return true end}}
      return {Core=require("src.core.run_core").RunCore, Session=require("src.core.run_session").RunSession,
        Run=require("src.game.multiplayer_run").MultiplayerRun, plan=require("src.core.quest_plan").makeQuestPlan,
        validate=require("src.core.config").validateConfig,catalog=require("src.game.default_config").monsterCatalog}
    '''))
    lua.globals().raw_config = lua.table_from(json.loads((ROOT / 'data/rogue_config.json').read_text(encoding='utf-8')), recursive=True)
    lua.execute('''
      assert(JSON==nil and Date==nil and Array==nil)
      local function new(C,...) local o=setmetatable({},C.prototype);o:____constructor(...);return o end
      local cfg=m.validate(nil,raw_config); cfg.quest.id=900103
      cfg.runtime.carveSeconds=1;cfg.runtime.campDwellSeconds=0
      core=new(m.Core,cfg,42)
      port={prepared=0,reading={time=clock,quest={id=900103,unique=7,playing=true,status="play"},
        online=true,canPost=false,deaths=0,enemies={},players={
        {id=0,position={x=10,y=20,z=30}},{id=1,position={x=10,y=20,z=30}}}}}
      function port:now() return clock end
      function port:ready() return true end
      function port:read() self.reading.time=clock;return self.reading end
      function port:publish() self.prepared=self.prepared+1 end
      function port:policy() end
      function port:cancelPost() end
      function port:postingError() return nil end
      function port:takeDeaths() return {} end
      function port:report() end
      function port:finish() error("unexpected native finish in protocol test") end
      function port:multiplayerRole() return run and run.role end
      function port:multiplayerValid() return run and run:valid() end
      function port:multiplayerCanChoose() return run and run:canChoose() end
      session=new(m.Session,core,m.catalog,port)
      local runtime={publish=function() port.prepared=port.prepared+1 end,report=function() end}
      local net={steam_digest=wire_hash,steam_snapshot=net_snapshot,steam_plan=net_plan,steam_ack=net_ack}
      run=new(m.Run,{lobby="local-test",owner="h",self=peer_role,session="process-test",members={"h","g"}},
        cfg,m.catalog,session,runtime,function() return false end,net)
      local wave={index=0,mode="single",typeTag="A",label="entry",monsters={"Great Izuchi"},tier="weak",hpMul=1,dmgMul=1,rewardMul=0,rewardPt=0}
      assert(session:adoptMultiplayerEntry(m.plan(nil,cfg,m.catalog,wave,1,1,false)).ok)
      session:tick()
      function act(command)
        clock=command.now or clock
        local result=nil
        if command.op=="tick" then session:tick();run:tick()
        elseif command.op=="choose" then result=session:choose(command.index).ok; if result then port.reading.enemies={} end
        elseif command.op=="spend" then result=core:buy("honey").ok
        elseif command.op=="kill" then
          port.reading.enemies={}
          for i,id in ipairs(session.plan.monsterIds) do port.reading.enemies[i]={uid=core.state.layer*100+i,typeId=id,dead=true,captured=false} end
        elseif command.op=="stage" then run:staged(command.ticket)
        elseif command.op=="activate" then result=run:activate(command.ticket)
        end
        return {result=result,role=run.role,live=run:valid(),stage=session.stage,pt=core.state.wallet.pt,
          layer=core.state.layer,canChoose=session:canChoose(),token=session.plan.token,
          monsters=session.plan.monsterIds,reward=session.plan.wave.rewardPt,prepared=port.prepared,message=session.message}
      end
    ''')
    print(json.dumps({'ready': True, 'pid': os.getpid(), 'role': role}), flush=True)
    for line in sys.stdin:
        command = json.loads(line)
        if command['op'] == 'close':
            break
        try:
            result = plain(lua.globals().act(lua.table_from(command, recursive=True)))
            print(json.dumps(result, ensure_ascii=False), flush=True)
        except Exception as error:
            print(json.dumps({'error': str(error)}), flush=True)


def orchestrate(report):
    state = {'plan': '', 'acks': {}}
    lock = threading.Lock()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def answer(self, value):
            body = json.dumps(value).encode()
            self.send_response(200)
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            peer = parse_qs(urlparse(self.path).query)['peer'][0]
            with lock:
                self.answer({'available': True, 'reason': '', 'lobbies': [{'id': 'local-test', 'owner': 'h', 'self': peer,
                  'plan': state['plan'], 'members': [{'id': p, 'ack': state['acks'].get(p, '')} for p in ['h', 'g']]}]})

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            with lock:
                if self.path == '/plan':
                    assert body['peer'] == 'h' and len(body['value'].encode()) <= 2048
                    state['plan'] = body['value']
                elif self.path == '/ack':
                    state['acks'][body['peer']] = body['value']
                else:
                    raise AssertionError('Unknown test route')
                self.answer({'ok': True})

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f'http://127.0.0.1:{server.server_port}'
    peers = {}
    identities = {}
    clock = 100

    def send(peer, op, **args):
        process = peers[peer]
        process.stdin.write(json.dumps({'op': op, 'now': clock, **args}) + '\n')
        process.stdin.flush()
        line = process.stdout.readline()
        assert line, f'Worker {peer} exited unexpectedly'
        value = json.loads(line)
        assert 'error' not in value, value
        return value

    def tick(count=1):
        nonlocal clock
        for _ in range(count):
            clock += 1
            send('h', 'tick')
            send('g', 'tick')

    checks = []
    try:
        for role in ['h', 'g']:
            peers[role] = subprocess.Popen([sys.executable, '-u', __file__, '--worker', role, base],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, encoding='utf-8', cwd=ROOT,
                env={**os.environ, 'PYTHONIOENCODING': 'utf-8'})
            identities[role] = json.loads(peers[role].stdout.readline())
        assert identities['h']['pid'] != identities['g']['pid'] != os.getpid()
        checks.append('distinct OS processes / independent emitted Lua states / real TCP transport')
        tick(2)
        send('h', 'kill'); tick(4)
        assert send('h', 'summary')['canChoose']
        assert send('g', 'choose', index=0)['result'] is False
        assert send('g', 'spend')['pt'] == 135
        assert send('h', 'summary')['pt'] == 150
        checks.append('guest choice rejected / guest purchase does not charge host')
        assert send('h', 'choose', index=0)['result'] is True
        tick(2)
        host = send('h', 'summary')
        assert send('g', 'summary')['prepared'] == 1
        ticket = {'token': host['token'], 'ordinal': 0, 'type': host['monsters'][0], 'slot': 2, 'id': 3, 'uid': 300}
        send('h', 'stage', ticket=ticket)
        assert send('h', 'activate', ticket=ticket)['result'] is False
        tick(); send('g', 'stage', ticket=ticket); tick(2)
        assert send('h', 'activate', ticket=ticket)['result'] is True
        tick(); assert send('g', 'activate', ticket=ticket)['result'] is True
        tick(2)
        checks.append('stage / all-peer ACK barrier / commit / guest activation')
        send('h', 'kill'); tick(4)
        host, guest = send('h', 'summary'), send('g', 'summary')
        assert host['layer'] == guest['layer'] == 3
        assert host['pt'] == 150 + host['reward'] and guest['pt'] == 135 + host['reward']
        pt = guest['pt']; tick(3); assert send('g', 'summary')['pt'] == pt
        checks.append('same next layer / one reward only / personal spending preserved')
        frozen_ack = state['acks']['g']
        clock += 16
        host = send('h', 'tick')
        assert host['live'] and not host['canChoose']
        clock += 121
        host = send('h', 'tick')
        assert host['stage'] == 'Fault' and not host['live'] and state['acks']['g'] == frozen_ack
        checks.append('frozen guest cached ACK expires / next choice blocked / host timeout')
        result = {'ok': True, 'scope': 'business protocol only; no second Rise engine or native items',
                  'workers': identities, 'transport': base, 'checks': checks, 'host': host, 'guestBeforeFreeze': guest}
        if report:
            Path(report).write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps(result, ensure_ascii=False, indent=2))
    finally:
        for process in peers.values():
            if process.poll() is None:
                try:
                    process.stdin.write('{"op":"close"}\n'); process.stdin.flush(); process.wait(timeout=5)
                except (OSError, subprocess.TimeoutExpired):
                    process.terminate(); process.wait(timeout=5)
        server.shutdown(); server.server_close()


if __name__ == '__main__':
    if len(sys.argv) >= 4 and sys.argv[1] == '--worker':
        worker(sys.argv[2], sys.argv[3])
    else:
        parser = argparse.ArgumentParser(description=__doc__)
        parser.add_argument('--report')
        orchestrate(parser.parse_args().report)
