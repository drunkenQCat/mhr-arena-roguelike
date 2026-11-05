<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import ConfigEditor from "./ConfigEditor.vue";
import PlayWorkspace from "./PlayWorkspace.vue";
import MultiplayerEntry from "./MultiplayerEntry.vue";
import ConnectionHelp from "./ConnectionHelp.vue";
import SupportBar from "./SupportBar.vue";
import { Freshness, SubmissionUncertain, downloadJson, getJson, postCommand, waitForReceipt, type ConsoleState, type CommandResult } from "./api";

const state = ref<ConsoleState | null>(null), stale = ref(true), busy = ref(false);
const pages = ['play', 'multiplayer', 'help', 'design', 'events'];
const readPage = () => pages.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'play';
const notice = ref(""), lastSync = ref("—"), page = ref(readPage());
const toolsOpen = ref(['design', 'events'].includes(page.value));
const syncPage = () => { page.value = readPage(); };
watch(page, value => {
  if (location.hash !== `#${value}`) history.replaceState(null, '', `#${value}`);
  if (['design', 'events'].includes(value)) toolsOpen.value = true;
});
const results = ref<CommandResult[]>([]), filter = ref("");
const config = ref<unknown>(null), loadedVersion = ref(0), configMessage = ref("");
const configBridgeId = ref("");
const heartbeat = new Freshness();
const developerMode = ref(false);
let alive = true, timer: ReturnType<typeof setTimeout> | undefined, loadedBridge = "";
const connected = computed(() => !stale.value && state.value?.protocol === 4);
watch(() => state.value?.multiplayerRun?.live, (live, previous) => {
  if (live && !previous && page.value === 'multiplayer') page.value = 'play';
});
watch([page, connected, busy, () => state.value?.bridgeId], () => {
  if (page.value === 'design' && connected.value && !busy.value && !config.value && loadedBridge !== state.value?.bridgeId) {
    loadedBridge = state.value!.bridgeId;
    void loadConfig();
  }
});
const recent = computed(() => [...results.value].reverse().filter((r) =>
  `${r.id} ${r.status} ${r.message ?? ''}`.toLowerCase().includes(filter.value.toLowerCase())).slice(0, 30));

async function send(cmd: string, extra: Record<string, unknown> = {}): Promise<CommandResult | null> {
  if (!connected.value || busy.value || !state.value) return null;
  busy.value = true; notice.value = "正在提交，等待游戏执行…";
  const bridge = state.value.bridgeId;
  try {
    let id: string;
    try { id = await postCommand(state.value, cmd, extra); }
    catch (error) {
      if (!(error instanceof SubmissionUncertain)) throw error;
      id = error.requestId; notice.value = error.message;
    }
    const result = await waitForReceipt(id, bridge, { purchase: cmd === "buy", effect: cmd === "killAll" || cmd === "teleport", alive: () => alive,
      onPacket: (packet) => { results.value = packet.history ?? []; } });
    const labels: Record<string, string> = { startRun: '已开始本局', choose: '已选择波次', setRoute: '路线已更新', setInvincible: '无敌设置已更新', killAll: '目标状态已确认', teleport: '位置已确认', stop: '已停止，正在通过原生结算返回村庄', retryPost: '已提交出发请求', getConfig: '配置已读取', buy: '购买完成' };
    notice.value = result.status === 'applied' ? (cmd === 'buy' ? '购买完成，结果显示在商店中' : labels[cmd] ?? result.message ?? '操作完成') : `${result.status === 'queued' ? '游戏已排队，等待实际结果' : result.status === 'uncertain' ? '结果待核实，请勿重试' : '已拒绝'}：${result.message ?? '请检查当前条件'}`;
    return result;
  } catch (e) { notice.value = String(e).replace("Error: ", ""); return null; }
  finally { busy.value = false; }
}

async function loadConfig() {
  const result = await send("getConfig");
  if (result?.status === "applied" && result.config) {
    config.value = result.config; loadedVersion.value = result.configVersion ?? 0;
    configBridgeId.value = state.value?.bridgeId ?? "";
    configMessage.value = "已从游戏 Lua 读取配置，包含已提交的下一局规则；当前波次计划保持冻结。";
  } else configMessage.value = notice.value;
}
async function submitConfig(value: unknown, version: number) {
  const result = await send("submitConfig", { config: value, configVersion: version, bridgeId: configBridgeId.value });
  configMessage.value = result?.message ?? notice.value;
  if (result?.status === "applied") {
    // Keep the exact normalized submitted draft as the new baseline after the game confirms.
    config.value = value; loadedVersion.value = result.configVersion!;
  }
}
async function poll() {
  if (!alive) return;
  const responses = await Promise.allSettled([
    getJson<ConsoleState>("/api/state", AbortSignal.timeout(3000)),
    getJson<{ history?: CommandResult[] | null }>("/api/results", AbortSignal.timeout(3000)),
  ]);
  if (!alive) return;
  const current = responses[0];
  if (current.status === "fulfilled" && current.value.ok) {
    const s = current.value; state.value = s;
    heartbeat.observe(s, performance.now());
    stale.value = heartbeat.stale(performance.now()) ||
      (!!s.publishedAt && Date.now() / 1000 - s.publishedAt > 5) ||
      (!!s.sampledAt && Date.now() / 1000 - s.sampledAt > 5);
    if (!stale.value) lastSync.value = new Date().toLocaleTimeString();
    if (config.value && configBridgeId.value !== s.bridgeId)
      configMessage.value = "脚本已重载。草稿仍保留，请重新载入游戏配置核对版本。";
  } else stale.value = true;
  const receipt = responses[1];
  if (receipt.status === "fulfilled") results.value = receipt.value.history ?? [];
  timer = setTimeout(() => void poll(), 500);
}
onMounted(() => { window.addEventListener('hashchange', syncPage); void poll(); });
onUnmounted(() => { alive = false; clearTimeout(timer); window.removeEventListener('hashchange', syncPage); });

</script>

<template>
  <main>
    <header class="app-header"><div><p class="eyebrow">MHR ARENA ROGUELIKE</p><h1>斗技场控制台</h1></div>
      <div class="connection"><span :class="['badge', connected ? 'live' : 'warning']">{{ !state ? '等待连接游戏' : stale ? '游戏状态暂未更新' : state.protocol !== 4 ? '脚本版本不匹配' : '已连接游戏' }}</span>
        <small>最近同步 {{ lastSync }}</small></div>
    </header>
    <p v-if="state?.testMode" class="alert">隔离验证环境：执行编译后的 Lua，玩家、怪物、背包与传输使用测试替身，不会操作实际游戏。</p>
    <p v-if="state && state.protocol !== 4" class="alert">网页与游戏脚本版本不匹配，操作已暂停。请先安全结束任务、回村并完成保存，再更新匹配版本；不要在任务中重载脚本。</p>
    <nav class="toolbar topnav" aria-label="控制台导航">
      <button :class="{ selected: page === 'play' }" :aria-pressed="page === 'play'" @click="page = 'play'">当前局</button>
      <button :class="{ selected: page === 'multiplayer' }" :aria-pressed="page === 'multiplayer'" @click="page = 'multiplayer'">联机大厅</button>
      <button :class="{ selected: page === 'help' }" :aria-pressed="page === 'help'" @click="page = 'help'">帮助与连接</button>
      <button class="tools-toggle" :aria-expanded="toolsOpen" aria-controls="console-tools" @click="toolsOpen = !toolsOpen">更多工具</button>
    </nav>
    <nav v-if="toolsOpen" id="console-tools" class="toolbar" aria-label="策划与诊断工具">
      <button :class="{ selected: page === 'design' }" :aria-pressed="page === 'design'" @click="page = 'design'">策划工作台</button>
      <button :class="{ selected: page === 'events' }" :aria-pressed="page === 'events'" @click="page = 'events'">命令记录</button>
    </nav>
    <p v-if="!connected" class="notice" role="status">{{ state ? '暂不能操作游戏，显示的数据可能已过期。请回游戏查看是否正在加载；恢复同步后按钮会重新可用。' : '请启动游戏并进入村庄，页面会自动连接。首次使用可查看“帮助与连接”。' }}</p>
    <p v-if="notice" class="notice" role="status">{{ notice }}</p>
    <template v-if="page === 'help'">
      <ConnectionHelp v-model:developer="developerMode" />
      <SupportBar />
      <p class="muted">联机测试版 · 本机双客户端已通过续波、个人购物和共享猫车；不同电脑的官方 Steam 联机仍待验收。三／四人实机仍待验收。</p>
    </template>
    <MultiplayerEntry v-if="page === 'multiplayer'" :entry="state?.multiplayerEntry" :run="state?.multiplayerRun" :connected="connected" :busy="busy || !connected" @command="send" @play="page = 'play'" />
    <PlayWorkspace v-show="page === 'play'" :state="state" :connected="connected" :busy="busy" :notice="notice" :developer-mode="developerMode" @command="send" @multiplayer="page = 'multiplayer'" />
    <ConfigEditor v-show="page === 'design'" :config="config" :version="loadedVersion" :server-version="state?.configVersion ?? loadedVersion" :session-changed="!!configBridgeId && configBridgeId !== state?.bridgeId" :busy="busy" :connected="connected" :message="configMessage" @load="loadConfig" @submit="submitConfig" />
    <section v-if="page === 'events'" class="panel"><div class="section-heading"><h2>命令记录</h2><button @click="downloadJson('console-results.json', results)">导出记录</button></div><label>筛选记录 <input v-model="filter" placeholder="状态 / 请求 ID / 消息" /></label><p class="muted">applied 表示命令已执行；queued 仍需等待游戏结果；rejected 表示未执行。</p><article v-for="r in recent" :key="r.id" class="event"><span :class="['badge', r.status === 'applied' ? 'live' : r.status === 'queued' ? 'pending' : 'warning']">{{ r.status }}</span><span>{{ r.message ?? (r.config ? '已读取游戏配置' : '') }}</span><small class="mono">{{ r.id }}</small></article></section>
  </main>
</template>

<style>
:root{color-scheme:dark;font-family:'Microsoft YaHei',system-ui,sans-serif;color:#eadfce;background:#14110d;font-synthesis:none}*{box-sizing:border-box}body{margin:0}main{max-width:1250px;padding:28px 24px 64px;margin:auto}h1,h2,h3,p{margin:0 0 14px}h1{font-size:25px;color:#f0ce86}h2{font-size:19px}h3{font-size:16px;margin-top:18px}.eyebrow{font-size:11px;letter-spacing:2px;color:#b6a181;margin-bottom:7px}.app-header,.section-heading{display:flex;justify-content:space-between;align-items:center;gap:20px;flex-wrap:wrap}.app-header{margin-bottom:24px}.connection{display:grid;gap:8px;text-align:right}.dashboard{display:grid;grid-template-columns:1fr 1fr;gap:16px}.panel{background:#201b15;border:1px solid #4a3e2c;border-radius:10px;padding:22px}.full{grid-column:1/-1}.toolbar,.tabs{display:flex;align-items:center;flex-wrap:wrap;gap:10px}.toolbar{margin:12px 0 18px}.topnav{margin-bottom:18px}.tabs{margin:18px 0;border-bottom:1px solid #4a3e2c;padding-bottom:12px}button{font:inherit;font-size:13px;padding:9px 14px;min-height:38px;background:#302719;border:1px solid #7c6743;border-radius:6px;color:#ecd5a5;cursor:pointer}button:hover:not(:disabled){background:#4c3b22}button:disabled{opacity:.45;cursor:not-allowed}button.selected,button.primary{background:#b68b42;border-color:#cba459;color:#18130b;font-weight:650}button.danger{color:#f3b6a7;border-color:#875044}button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,summary:focus-visible{outline:2px solid #f0ce86;outline-offset:3px}.badge{display:inline-block;padding:5px 9px;background:#302719;border:1px solid #655237;border-radius:5px;font-size:12px;color:#cbbb9d}.badge.live{color:#b6d6a7;background:#263023;border-color:#536e46}.warning,.alert{color:#ffc6ae}.notice,.alert{padding:12px 14px;background:#2a2319;border-left:3px solid #b68b42;border-radius:3px;font-size:14px;line-height:1.6;margin:14px 0}.alert{background:#35231e;border-color:#d08062}.muted,.meta,small{color:#b6a995;font-size:12px;line-height:1.6}.meta{overflow-wrap:anywhere}small{display:block}.metrics{display:flex;gap:35px;margin:22px 0}.metrics strong{display:block;font-size:28px;font-variant-numeric:tabular-nums}.gold{color:#efd08b}.player{display:grid;gap:7px;padding:12px 0;border-bottom:1px solid #3e3427}.mono{font-family:Consolas,monospace;font-size:12px}.choice-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}.subpanel{background:#191510;border:1px solid #53432d;border-radius:7px;padding:17px;margin-bottom:14px}.choice-grid article{display:flex;flex-direction:column;gap:10px;margin:0}.choice-grid h3{margin:0;font-size:15px;line-height:1.6}.choice-grid .primary{margin-top:auto}.fields{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:18px;margin:18px 0 24px}.number-field,.text-field{display:flex;flex-direction:column;gap:7px;font-size:13px}.number-field input{font-size:17px;font-variant-numeric:tabular-nums}input,select,textarea{font:inherit;background:#15120e;border:1px solid #6b593f;border-radius:5px;padding:9px 10px;color:#eee2cf;max-width:100%}input[type=number]{width:100%;min-width:75px}input[type=checkbox]{width:auto;accent-color:#bc9658}select{min-height:38px}.check{display:flex;align-items:center;gap:7px;font-size:13px}.text-field textarea{width:100%}.table-scroll{overflow:auto}table{border-collapse:collapse;width:100%;font-size:13px}th,td{text-align:left;padding:13px 10px;border-bottom:1px solid #443728;vertical-align:middle}th{color:#bfae8b;font-size:12px;font-weight:500}td input{max-width:115px}td:first-child{min-width:125px}td small{margin-top:5px}.chips{display:flex;gap:7px;flex-wrap:wrap;margin:10px 0}.chips button{min-height:30px;padding:4px 9px}.monster-group{margin:18px 0}.monster-group>select{width:100%}.editor{margin-top:16px}.editor-body{min-height:300px}.advanced{border-top:1px solid #4a3e2c;padding-top:16px;margin-top:22px}.advanced textarea{display:block;width:100%;font-family:Consolas,monospace;margin:14px 0}summary{cursor:pointer;color:#c7b797;font-size:13px}.submit-bar{position:sticky;bottom:10px;background:#292116;border:1px solid #7c6743;border-radius:7px;padding:14px;display:flex;justify-content:space-between;align-items:center;gap:20px;margin-top:22px;font-size:12px}.event{display:flex;gap:12px;align-items:center;flex-wrap:wrap;border-bottom:1px solid #443728;padding:14px 0}.event small{margin-left:auto}.empty{padding:30px;line-height:1.8}.visually-hidden{position:absolute;width:1px;height:1px;clip:rect(0,0,0,0);overflow:hidden}details p{margin-top:12px}
button.selected:hover:not(:disabled),button.primary:hover:not(:disabled){background:#cba459;color:#18130b}
@media(max-width:800px){main{padding:18px 12px 45px}.dashboard,.choice-grid{grid-template-columns:1fr}.fields{grid-template-columns:repeat(2,minmax(0,1fr))}.panel{padding:17px}.connection{text-align:left}.submit-bar{flex-direction:column;align-items:stretch}.metrics{gap:24px}.full{grid-column:auto}}
@media(max-width:480px){.fields{grid-template-columns:1fr}.metrics strong{font-size:23px}.app-header{gap:8px}}
</style>

<style scoped>
.topnav button{min-height:44px}.tools-toggle{margin-left:auto}
@media(max-width:480px){.topnav{display:grid;grid-template-columns:1fr 1fr}.tools-toggle{margin-left:0}}
</style>
