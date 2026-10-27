<script setup lang="ts">
import { onMounted, ref } from "vue";

interface ShopEntry { id: string; name: string; category: string; price: number; cap: number; owned: number; mode: string; desc: string | null; canBuy: boolean; reason: string | null; }
interface WaveChoice { index: number; typeTag: string; label: string; monsters: string[]; rewardMul: number; hpMul: number; dmgMul: number; rewardPt: number; }
interface State {
  ok: boolean; protocol: number; counter: number; bridgeId: string; configVersion: number;
  sessionStage: string; corePhase: string; questId: number; questUnique: number | null;
  layer: number; pt: number; cartsLeft: number; maxCarts: number; armor: string | null;
  invincible: boolean; activeWave: string | null; choices: WaveChoice[] | null;
  shopNotice: string | null; shopBusy: boolean; message: string;
}

const state = ref<State | null>(null);
const stale = ref(true);
const lastSync = ref("—");
const bridgeId = ref("");
const results = ref<Array<Record<string, unknown>>>([]);
const notice = ref("");
const configDraft = ref("");
const configMessage = ref("");
const filterText = ref("");
let requestCounter = 0;

async function jget<T>(path: string): Promise<T | null> {
  try {
    const r = await fetch(path, { cache: "no-store" });
    stale.value = false;
    lastSync.value = new Date().toLocaleTimeString();
    return (await r.json()) as T;
  } catch { stale.value = true; return null; }
}

async function jpost<T>(path: string, body: unknown): Promise<T | null> {
  try {
    const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return await r.json() as T;
  } catch { stale.value = true; return null; }
}

async function send(cmd: string, extra: Record<string, unknown> = {}): Promise<void> {
  requestCounter++;
  const payload = { id: `web-${Date.now()}-${requestCounter}`, bridgeId: bridgeId.value, cmd, ...extra };
  const r = await jpost<{ ok?: boolean; queued?: boolean }>("/api/command", payload);
  notice.value = r?.queued ? `已排队：${cmd}` : `已发送：${cmd}`;
}

async function poll(): Promise<void> {
  const s = await jget<State>("/api/state");
  if (s && s.ok) { state.value = s; bridgeId.value = s.bridgeId; }
}

async function pollResults(): Promise<void> {
  const r = await jget<{ history?: Array<Record<string, unknown>> }>("/api/results");
  if (r) results.value = r.history ?? [];
}

async function loadConfig(): Promise<void> {
  try {
    const r = await fetch("/api/config", { cache: "no-store" });
    configDraft.value = r.ok ? JSON.stringify(await r.json(), null, 2) : "{}";
    configMessage.value = r.ok ? "已载入当前生效配置" : "服务器无覆盖配置（使用内嵌默认）";
  } catch { configMessage.value = "读取配置失败"; }
}

async function submitConfig(): Promise<void> {
  try {
    const parsed = JSON.parse(configDraft.value);
    await send("submitConfig", { config: parsed });
    configMessage.value = "已提交（校验结果见最近命令结果；提交同时写入持久覆盖）";
  } catch (e) { configMessage.value = `配置解析失败：${String(e)}`; }
}

function exportResults(): void {
  const blob = new Blob([JSON.stringify({ results: results.value }, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `webconsole-results-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function visibleResults(): Array<Record<string, unknown>> {
  const f = filterText.value.trim();
  if (!f) return results.value.slice(0, 20);
  return results.value.filter((r) => JSON.stringify(r).includes(f)).slice(0, 20);
}

onMounted(() => {
  void poll(); void pollResults(); void loadConfig();
  setInterval(() => void poll(), 500);
  setInterval(() => void pollResults(), 2000);
});
</script>

<template>
  <div id="root">
    <header>
      <h1>MHR 斗技场肉鸽 · Web 控制台</h1>
      <span :class="['conn', stale ? 'stale' : 'live']">{{ stale ? "⚠ 连接断开 / 状态过期" : "● 已连接" }}</span>
      <span class="meta">协议 v{{ state?.protocol ?? "—" }} · 同步 {{ lastSync }} · bridgeId {{ state?.bridgeId ?? "—" }} · 配置 v{{ state?.configVersion ?? "—" }}</span>
    </header>

    <section v-if="state" class="grid">
      <div class="card">
        <h2>状态</h2>
        <div class="row"><span>任务</span><b>#{{ state.questId }}</b>（unique {{ state.questUnique ?? "—" }}）</div>
        <div class="row"><span>会话 / 核心</span><b>{{ state.sessionStage }} / {{ state.corePhase }}</b></div>
        <div class="row"><span>层数</span><b>{{ state.layer }}</b></div>
        <div class="row"><span>PT</span><b>{{ state.pt }}</b></div>
        <div class="row"><span>猫车</span><b>{{ state.cartsLeft }} / {{ state.maxCarts }}</b></div>
        <div class="row"><span>无敌</span><b>{{ state.invincible ? "开" : "关" }}</b></div>
        <div class="row"><span>装备</span><b>{{ state.armor ?? "—" }}</b></div>
        <div class="row"><span>本层</span><b>{{ state.activeWave ?? "—" }}</b></div>
        <div class="row"><span>消息</span><span>{{ state.message }}</span></div>
      </div>

      <div class="card">
        <h2>操作</h2>
        <div class="row"><span>开局</span>
          <span>
            <button @click="send('startRun', { armor: '骨套（均衡）' })">骨套</button>
            <button @click="send('startRun', { armor: '铁套（攻高防低）' })">铁套</button>
          </span>
        </div>
        <div class="row"><span>无敌</span>
          <span>
            <button @click="send('setInvincible', { value: true })">开</button>
            <button @click="send('setInvincible', { value: false })">关</button>
          </span>
        </div>
        <div class="row"><span>清场</span><span><button @click="send('killAll')">击杀已出场怪</button></span></div>
        <div class="row"><span>接取</span><span><button @click="send('retryPost')">重试原生接取</button></span></div>
        <div class="row"><span>路线</span>
          <span>
            <button @click="send('setRoute', { route: 'reentry' })">reentry</button>
            <button @click="send('setRoute', { route: 'inPlace' })">inPlace</button>
          </span>
        </div>
        <div class="row"><span>终止</span><span><button @click="send('stop')">停止本局</button></span></div>
      </div>

      <div class="card wide">
        <h2>三选一</h2>
        <p v-if="state.shopBusy">商店交易进行中…</p>
        <div v-for="(c, i) in state.choices ?? []" :key="i" class="choice">
          <b>{{ c.label }}</b>
          <span class="num">HP ×{{ c.hpMul }} · 伤害 ×{{ c.dmgMul }} · 奖励 {{ c.rewardPt }} PT</span>
          <button :disabled="state.shopBusy" @click="send('choose', { index: c.index })">选择</button>
        </div>
        <p v-if="!state.choices?.length" class="dim">当前没有待选波次。</p>
      </div>

      <div class="card wide">
        <h2>商店（整备/选任务阶段可购）</h2>
        <p>{{ state.shopNotice ?? "—" }}</p>
        <p class="dim">发货=写入道具袋并读回校验；失败自动恢复 PT 与限购记录。补满/服务类暂未开放。</p>
      </div>

      <div class="card wide">
        <h2>策划数值</h2>
        <p class="dim">生效点：商店/池/倍率即时影响下次取值；开局 PT 等下一局生效；当前波奖励随计划冻结。</p>
        <textarea v-model="configDraft" rows="14" spellcheck="false"></textarea>
        <div class="row">
          <button @click="loadConfig">载入当前生效配置</button>
          <button @click="submitConfig">校验并提交</button>
          <span>{{ configMessage }}</span>
        </div>
      </div>

      <div class="card wide">
        <h2>命令结果 / 事件</h2>
        <div class="row">
          <input v-model="filterText" placeholder="筛选…" />
          <button @click="exportResults">导出 JSON</button>
        </div>
        <div v-for="(r, i) in visibleResults()" :key="i" class="ev">{{ JSON.stringify(r) }}</div>
      </div>
    </section>
    <p v-else>连接中…（确保游戏运行且插件已加载）</p>
  </div>
</template>

<style>
:root { color-scheme: dark; }
body { background: #14110d; color: #e8dcc8; font-family: "Microsoft YaHei", system-ui, sans-serif; margin: 0; }
#root { max-width: 980px; margin: 0 auto; padding: 16px; }
header { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
h1 { font-size: 18px; color: #f0c96a; }
.conn.live { color: #7fb069; }
.conn.stale { color: #e07a5f; }
.meta { font-size: 12px; color: #9a8f78; }
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.card { background: #1d1812; border: 1px solid #4a3f2c; border-radius: 8px; padding: 12px; }
.card.wide { grid-column: 1 / -1; }
h2 { font-size: 14px; color: #b8a67a; margin-bottom: 8px; }
.row { display: flex; justify-content: space-between; gap: 8px; padding: 3px 0; align-items: center; flex-wrap: wrap; }
.row > span:first-child { color: #9a8f78; }
button { background: #4a3b22; color: #f0c96a; border: 1px solid #8a744a; border-radius: 5px; padding: 4px 10px; cursor: pointer; }
button:hover:not(:disabled) { background: #6b5630; }
button:disabled { opacity: 0.4; cursor: not-allowed; }
.choice { border: 1px solid #3a3020; border-radius: 6px; padding: 8px; margin: 6px 0; display: grid; gap: 4px; }
.num { color: #7fb069; font-size: 12px; }
.dim { color: #7a7060; }
textarea { width: 100%; background: #100d09; color: #d8cdb4; border: 1px solid #4a3f2c; border-radius: 4px; font-family: Consolas, monospace; }
input { background: #100d09; color: #e8dcc8; border: 1px solid #4a3f2c; border-radius: 4px; padding: 4px 8px; }
.ev { font-family: Consolas, monospace; font-size: 12px; color: #9a8f78; padding: 2px 0; border-bottom: 1px dashed #2c2418; overflow-wrap: anywhere; }
</style>
