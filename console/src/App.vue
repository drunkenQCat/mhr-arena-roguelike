<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import ConfigEditor from "./ConfigEditor.vue";
import { Freshness, SubmissionUncertain, downloadJson, getJson, postCommand, waitForReceipt, type ConsoleState, type CommandResult } from "./api";

const state = ref<ConsoleState | null>(null), stale = ref(true), busy = ref(false);
const notice = ref("等待游戏状态"), lastSync = ref("—"), page = ref("play");
const results = ref<CommandResult[]>([]), filter = ref(""), category = ref("");
const config = ref<unknown>(null), loadedVersion = ref(0), configMessage = ref("");
const configBridgeId = ref("");
const heartbeat = new Freshness();
let alive = true, timer: ReturnType<typeof setTimeout> | undefined, loadedBridge = "";
const connected = computed(() => !stale.value && state.value?.protocol === 3);
const categoryOrder = ["基础补给", "弹药", "战术道具", "调和素材", "高阶药品", "翻盘服务"];
const categories = computed(() => Object.keys(state.value?.shop ?? {}).sort((a, b) =>
  (categoryOrder.indexOf(a) < 0 ? 99 : categoryOrder.indexOf(a)) - (categoryOrder.indexOf(b) < 0 ? 99 : categoryOrder.indexOf(b))));
const shopList = computed(() => state.value?.shop?.[category.value] ?? []);
const recent = computed(() => [...results.value].reverse().filter((r) =>
  `${r.id} ${r.status} ${r.message ?? ''}`.toLowerCase().includes(filter.value.toLowerCase())).slice(0, 30));
const prep = computed(() => state.value?.preparation);
const stageNames: Record<string, string> = { Idle: "未开局", Selecting: "整备 / 选择波次", AwaitQuest: "等待进入任务", Combat: "战斗中", Carve: "剥取 / 返回集结点", Returning: "返回村庄", Finished: "本局结束", Fault: "流程异常" };
watch(categories, (values) => { if (!values.includes(category.value)) category.value = values[0] ?? ""; });

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
    const result = await waitForReceipt(id, bridge, { purchase: cmd === "buy", alive: () => alive,
      onPacket: (packet) => { results.value = packet.history ?? []; } });
    notice.value = `${result.status === 'applied' ? '已执行' : result.status === 'queued' ? '游戏已排队，等待实际结果' : result.status === 'uncertain' ? '结果待核实，请勿重试' : '已拒绝'}：${result.message ?? cmd}`;
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
    if (s.protocol === 3 && loadedBridge !== s.bridgeId && !busy.value) {
      loadedBridge = s.bridgeId;
      if (!config.value) void loadConfig();
      else configMessage.value = "脚本已重载。草稿仍保留，请重新载入游戏配置核对版本。";
    }
  } else stale.value = true;
  const receipt = responses[1];
  if (receipt.status === "fulfilled") results.value = receipt.value.history ?? [];
  timer = setTimeout(() => void poll(), 500);
}
onMounted(() => void poll());
onUnmounted(() => { alive = false; clearTimeout(timer); });
const f = (value: number | null | undefined) => value == null ? "—" : value.toFixed(1);
</script>

<template>
  <main>
    <header class="app-header"><div><p class="eyebrow">MHR ARENA ROGUELIKE</p><h1>斗技场控制台</h1></div>
      <div class="connection"><span :class="['badge', connected ? 'live' : 'warning']">{{ stale ? '游戏状态已过期 / 连接断开' : state?.protocol !== 3 ? '旧版脚本，等待重载' : '游戏状态同步中' }}</span>
        <small>同步 {{ lastSync }} · 状态 #{{ state?.counter ?? '—' }} · 配置 v{{ state?.configVersion ?? '—' }}</small></div>
    </header>
    <p v-if="state?.testMode" class="alert">隔离验证环境：Lua 与 HTTP 为真实构建，玩家、怪物和背包是测试数据，不会操作实际游戏。</p>
    <p v-if="state && state.protocol !== 3" class="alert">当前 Lua 仍使用旧版协议，无法提供位置与商店资格。请在 REFramework → ScriptRunner 执行 Reset scripts；网页已禁止向旧脚本发送操作。</p>
    <div class="toolbar topnav"><button :class="{ selected: page === 'play' }" @click="page = 'play'">游戏与商店</button><button :class="{ selected: page === 'design' }" @click="page = 'design'">策划工作台</button><button :class="{ selected: page === 'events' }" @click="page = 'events'">命令记录</button></div>
    <p class="notice" role="status">{{ notice }}</p>
    <template v-if="page === 'play'">
      <div v-if="state" class="dashboard">
        <section class="panel"><div class="section-heading"><h2>{{ stageNames[state.sessionStage] ?? state.sessionStage }}</h2><span class="badge">第 {{ state.layer }} 层</span></div>
          <div class="metrics"><div><small>可用 PT</small><strong class="gold">{{ state.pt }}</strong></div><div><small>猫车</small><strong>{{ state.cartsLeft }} / {{ state.maxCarts }}</strong></div><div><small>本波已解决</small><strong>{{ prep?.resolved ?? '—' }} / {{ prep?.expected ?? '—' }}</strong></div></div>
          <p>{{ state.activeWave ?? '暂无进行中的波次' }}</p><p class="muted">{{ state.message }}</p>
          <div class="meta">任务 {{ state.questId ?? '未进入' }} · 实例 {{ state.questUnique ?? '—' }} · 波次 #{{ prep?.waveToken ?? '—' }} · {{ state.route ?? '—' }}</div>
          <details><summary>原生调度状态</summary><p class="mono">{{ state.runtimeStatus ?? '旧版脚本没有此信息' }}</p></details>
        </section>
        <section class="panel"><h2>玩家位置与集结</h2>
          <p v-if="!prep" class="muted">等待新版脚本的位置采样。</p>
          <div v-for="player in prep?.players ?? []" :key="player.id" class="player"><b>玩家 {{ player.id + 1 }}</b><span class="mono">X {{ f(player.position.x) }} / Y {{ f(player.position.y) }} / Z {{ f(player.position.z) }}</span><span>距集结点 {{ f(player.campDistance) }} / 半径 {{ prep?.radius }}</span></div>
          <p v-if="prep && !prep.players?.length" class="muted">等待玩家对象就绪。</p>
          <p v-if="prep?.camp" class="meta">集结点：{{ f(prep.camp.x) }}, {{ f(prep.camp.y) }}, {{ f(prep.camp.z) }}</p>
          <p v-if="state.sessionStage === 'Carve'" class="notice">{{ (prep?.carveRemaining ?? 0) > 0 ? `剥取等待 ${prep?.carveRemaining} 秒` : prep?.gathered ? `集结中，还需停留 ${prep.dwellRemaining} 秒` : '剥取等待已结束，请返回集结点' }}</p>
          <span :class="['badge', prep?.gathered ? 'live' : '']">{{ prep?.gathered ? '玩家已在集结范围' : '尚未集结 / 未进入任务' }}</span>
        </section>
        <section class="panel full"><h2>操作</h2><div class="toolbar">
          <button v-for="armor in state.armorOptions ?? []" :key="armor" :disabled="!connected || busy || !state.capabilities?.start" @click="send('startRun', { armor })">开局 · {{ armor }}</button>
          <button :disabled="!connected || busy" @click="send('setInvincible', { value: !state.invincible })">无敌 {{ state.invincible ? '已开启' : '已关闭' }}</button>
          <button :disabled="!connected || busy || state.sessionStage !== 'Combat'" @click="send('killAll')">击杀已出场怪物</button>
          <button :disabled="!connected || busy || !['AwaitQuest', 'Fault'].includes(state.sessionStage)" @click="send('retryPost')">重试接取</button>
          <button class="danger" :disabled="!connected || busy || !state.capabilities?.stop" @click="send('stop')">停止本局</button>
        </div></section>
        <section class="panel full"><div class="section-heading"><h2>下一波选择</h2><span class="muted">仅完成清波与集结后可选</span></div>
          <div v-if="state.sessionStage === 'Selecting'" class="choice-grid"><article v-for="c in state.choices ?? []" :key="c.index" class="subpanel"><span class="badge">{{ c.mode ?? '—' }}</span><h3>{{ c.label }}</h3><p>HP ×{{ c.hpMul }} · 伤害 ×{{ c.dmgMul }}</p><strong class="gold">{{ c.rewardPt }} PT</strong><button class="primary" :disabled="!connected || busy || !state.capabilities?.choose" @click="send('choose', { index: c.index })">选择此波次</button></article></div>
          <p v-else class="muted">{{ state.sessionStage === 'Combat' ? '当前波次正在战斗，完成后进入剥取和集结。' : '当前阶段没有可选波次。' }}</p>
        </section>
        <section class="panel full"><div class="section-heading"><h2>补给商店</h2><span :class="['badge', state.shopAvailable && connected ? 'live' : 'warning']">{{ state.shopAvailable && connected ? '可以购买' : '暂不可购买' }}</span></div>
          <p v-if="!state.shopAvailable" class="notice">{{ state.shopReason ?? '等待游戏更新购买资格' }}</p><p v-if="state.shopNotice" class="notice" role="status">{{ state.shopNotice }}</p>
          <nav class="tabs" aria-label="商店分类"><button v-for="c in categories" :key="c" :class="{ selected: category === c }" :aria-pressed="category === c" @click="category = c">{{ c }}</button></nav>
          <div class="table-scroll"><table><thead><tr><th>商品</th><th>价格</th><th>实际持有 / 上限</th><th>购买条件</th><th>操作</th></tr></thead><tbody><tr v-for="e in shopList" :key="e.id"><td>{{ e.name }}<small>{{ e.desc }}</small></td><td>{{ e.price }} PT</td><td>{{ e.mode === 'service' ? '—' : `${e.owned} / ${e.cap}` }}</td><td>{{ e.reason ?? '可购买' }}</td><td><button :disabled="!connected || busy || !state.shopAvailable || state.shopBusy || !e.canBuy" @click="send('buy', { itemId: e.id })">{{ e.mode === 'fill' ? '补满' : e.mode === 'service' ? '使用服务' : '购买 1 件' }}</button></td></tr></tbody></table></div>
          <p class="muted">购买资格与游戏内商店共用校验；排队不代表交付成功，最终以背包读回和交易提示为准。</p>
        </section>
      </div>
      <p v-else class="panel empty">等待游戏内服务发布状态。请确认 Rise 和 webconsole 插件已运行。</p>
    </template>
    <ConfigEditor v-show="page === 'design'" :config="config" :version="loadedVersion" :server-version="state?.configVersion ?? loadedVersion" :session-changed="!!configBridgeId && configBridgeId !== state?.bridgeId" :busy="busy" :connected="connected" :message="configMessage" @load="loadConfig" @submit="submitConfig" />
    <section v-if="page === 'events'" class="panel"><div class="section-heading"><h2>命令记录</h2><button @click="downloadJson('console-results.json', results)">导出记录</button></div><label>筛选记录 <input v-model="filter" placeholder="状态 / 请求 ID / 消息" /></label><p class="muted">applied 表示命令已执行；queued 仍需等待游戏结果；rejected 表示未执行。</p><article v-for="r in recent" :key="r.id" class="event"><span :class="['badge', r.status === 'rejected' ? 'warning' : 'live']">{{ r.status }}</span><span>{{ r.message ?? (r.config ? '已读取游戏配置' : '') }}</span><small class="mono">{{ r.id }}</small></article></section>
  </main>
</template>

<style>
:root{color-scheme:dark;font-family:'Microsoft YaHei',system-ui,sans-serif;color:#eadfce;background:#14110d;font-synthesis:none}*{box-sizing:border-box}body{margin:0}main{max-width:1250px;padding:28px 24px 64px;margin:auto}h1,h2,h3,p{margin:0 0 14px}h1{font-size:25px;color:#f0ce86}h2{font-size:19px}h3{font-size:16px;margin-top:18px}.eyebrow{font-size:11px;letter-spacing:2px;color:#b6a181;margin-bottom:7px}.app-header,.section-heading{display:flex;justify-content:space-between;align-items:center;gap:20px;flex-wrap:wrap}.app-header{margin-bottom:24px}.connection{display:grid;gap:8px;text-align:right}.dashboard{display:grid;grid-template-columns:1fr 1fr;gap:16px}.panel{background:#201b15;border:1px solid #4a3e2c;border-radius:10px;padding:22px}.full{grid-column:1/-1}.toolbar,.tabs{display:flex;align-items:center;flex-wrap:wrap;gap:10px}.toolbar{margin:12px 0 18px}.topnav{margin-bottom:18px}.tabs{margin:18px 0;border-bottom:1px solid #4a3e2c;padding-bottom:12px}button{font:inherit;font-size:13px;padding:9px 14px;min-height:38px;background:#302719;border:1px solid #7c6743;border-radius:6px;color:#ecd5a5;cursor:pointer}button:hover:not(:disabled){background:#4c3b22}button:disabled{opacity:.45;cursor:not-allowed}button.selected,button.primary{background:#b68b42;border-color:#cba459;color:#18130b;font-weight:650}button.danger{color:#f3b6a7;border-color:#875044}button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,summary:focus-visible{outline:2px solid #f0ce86;outline-offset:3px}.badge{display:inline-block;padding:5px 9px;background:#302719;border:1px solid #655237;border-radius:5px;font-size:12px;color:#cbbb9d}.badge.live{color:#b6d6a7;background:#263023;border-color:#536e46}.warning,.alert{color:#ffc6ae}.notice,.alert{padding:12px 14px;background:#2a2319;border-left:3px solid #b68b42;border-radius:3px;font-size:14px;line-height:1.6;margin:14px 0}.alert{background:#35231e;border-color:#d08062}.muted,.meta,small{color:#b6a995;font-size:12px;line-height:1.6}.meta{overflow-wrap:anywhere}small{display:block}.metrics{display:flex;gap:35px;margin:22px 0}.metrics strong{display:block;font-size:28px;font-variant-numeric:tabular-nums}.gold{color:#efd08b}.player{display:grid;gap:7px;padding:12px 0;border-bottom:1px solid #3e3427}.mono{font-family:Consolas,monospace;font-size:12px}.choice-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}.subpanel{background:#191510;border:1px solid #53432d;border-radius:7px;padding:17px;margin-bottom:14px}.choice-grid article{display:flex;flex-direction:column;gap:10px;margin:0}.choice-grid h3{margin:0;font-size:15px;line-height:1.6}.choice-grid .primary{margin-top:auto}.fields{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:18px;margin:18px 0 24px}.number-field,.text-field{display:flex;flex-direction:column;gap:7px;font-size:13px}.number-field input{font-size:17px;font-variant-numeric:tabular-nums}input,select,textarea{font:inherit;background:#15120e;border:1px solid #6b593f;border-radius:5px;padding:9px 10px;color:#eee2cf;max-width:100%}input[type=number]{width:100%;min-width:75px}input[type=checkbox]{width:auto;accent-color:#bc9658}select{min-height:38px}.check{display:flex;align-items:center;gap:7px;font-size:13px}.text-field textarea{width:100%}.table-scroll{overflow:auto}table{border-collapse:collapse;width:100%;font-size:13px}th,td{text-align:left;padding:13px 10px;border-bottom:1px solid #443728;vertical-align:middle}th{color:#bfae8b;font-size:12px;font-weight:500}td input{max-width:115px}td:first-child{min-width:125px}td small{margin-top:5px}.chips{display:flex;gap:7px;flex-wrap:wrap;margin:10px 0}.chips button{min-height:30px;padding:4px 9px}.monster-group{margin:18px 0}.monster-group>select{width:100%}.editor{margin-top:16px}.editor-body{min-height:300px}.advanced{border-top:1px solid #4a3e2c;padding-top:16px;margin-top:22px}.advanced textarea{display:block;width:100%;font-family:Consolas,monospace;margin:14px 0}summary{cursor:pointer;color:#c7b797;font-size:13px}.submit-bar{position:sticky;bottom:10px;background:#292116;border:1px solid #7c6743;border-radius:7px;padding:14px;display:flex;justify-content:space-between;align-items:center;gap:20px;margin-top:22px;font-size:12px}.event{display:flex;gap:12px;align-items:center;flex-wrap:wrap;border-bottom:1px solid #443728;padding:14px 0}.event small{margin-left:auto}.empty{padding:30px;line-height:1.8}.visually-hidden{position:absolute;width:1px;height:1px;clip:rect(0,0,0,0);overflow:hidden}details p{margin-top:12px}
@media(max-width:800px){main{padding:18px 12px 45px}.dashboard,.choice-grid{grid-template-columns:1fr}.fields{grid-template-columns:repeat(2,minmax(0,1fr))}.panel{padding:17px}.connection{text-align:left}.submit-bar{flex-direction:column;align-items:stretch}.metrics{gap:24px}.full{grid-column:auto}}
@media(max-width:480px){.fields{grid-template-columns:1fr}.metrics strong{font-size:23px}.app-header{gap:8px}}
</style>
