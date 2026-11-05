<script setup lang="ts">
import type { ConsoleState } from './api';
import { entryGuidance, modeNames } from './play-model';
defineProps<{ entry?: ConsoleState['multiplayerEntry']; run?: ConsoleState['multiplayerRun']; connected: boolean; busy: boolean }>();
const emit = defineEmits<{ command: [cmd: string, extra: Record<string, unknown>]; play: [] }>();
</script>

<template>
  <section class="panel entry-panel">
    <template v-if="run?.live">
      <p class="eyebrow">已接入本局</p>
      <h2>局内联机 · {{ run.role === 'host' ? '房主' : '队友' }}</h2>
      <p>{{ run.message }}</p>
      <p>选波由房主操作；每人在自己的控制台购物。个人 PT 和背包独立，猫车恢复由房主购买。</p>
      <button class="primary" @click="emit('play')">进入当前局 · 进度与商店</button>
    </template>
    <template v-else>
      <p class="eyebrow">与朋友一起狩猎</p>
      <div class="section-heading"><h2>联机大厅</h2><span class="badge">{{ !connected || !entry ? '等待大厅状态' : entry.role === 'host' ? '你是房主' : entry.role === 'guest' ? '你是队友' : '尚未进入大厅' }}</span></div>
      <p>保留自己的装备与背包，清波奖励每人独立结算。</p>
      <p class="notice" role="status">{{ entryGuidance(entry, connected) }}</p>
      <template v-if="connected && entry">
        <p v-if="entry.mode">入场波次：<strong>{{ modeNames[entry.mode] ?? entry.mode }}</strong></p>
        <div v-if="entry.role === 'host' && !entry.playing" class="toolbar" aria-label="入场波次">
          <button v-for="option in entry.options ?? []" :key="option.index" :class="{ selected: entry.mode === option.mode }" :aria-pressed="entry.mode === option.mode"
            :disabled="busy || !entry.canPrepare || entry.posting || !entry.sync.available"
            @click="emit('command', 'mpEntry', { sub: 'choose', index: option.index })">{{ option.label }}</button>
        </div>
        <ul v-if="entry.sync.members?.length" class="member-list">
          <li v-for="(member, index) in entry.sync.members" :key="member.id">
            <span>{{ member.self ? '你' : '队员 ' + (index + 1) }}</span>
            <span :class="['badge', member.ready ? 'live' : 'pending']">{{ member.ready ? '任务表一致' : '等待同步确认' }}</span>
          </li>
        </ul>
        <p v-if="entry.sync.members?.length" class="muted">同步完成只代表任务表一致。请在游戏内确认全员加入任务并准备好，再由房主手动出发。</p>
        <div class="toolbar">
          <button v-if="entry.role === 'host' && !entry.playing" class="primary" :disabled="busy || !entry.canPost || !entry.canPrepare || entry.posting"
            @click="emit('command', 'mpEntry', { sub: 'post' })">{{ entry.posting ? '等待全队确认…' : '承接联机任务' }}</button>
          <button v-if="entry.role === 'guest' && !entry.playing" :disabled="busy || !entry.canPrepare" @click="emit('command', 'mpEntry', { sub: 'retrySync' })">重试自动同步</button>
          <button v-if="entry.playing" class="primary" @click="emit('play')">查看当前局</button>
        </div>
        <p v-if="entry.message" role="status">{{ entry.message }}</p>
      </template>
      <details class="advanced"><summary>第一次联机 · 四步入场</summary>
        <ol>
          <li>所有人安装同一版本，通过游戏信使创建或加入同一个在线大厅。</li>
          <li>房主选择入场波次，等待全队“任务表一致”；队友不用选怪、复制任务码或输入 IP。</li>
          <li>房主承接任务，全队确认后打开柜台；队友从游戏内任务板加入。</li>
          <li>在游戏内确认参战名单与准备状态，房主手动出发。入场后到“当前局”购物与选波。</li>
        </ol>
        <p class="muted">至少两名真实 Steam 大厅成员全部确认才能承接。本机双客户端已通过测试，跨电脑官方 Steam 仍待验收；请在约好的私人大厅测试。</p>
      </details>
    </template>
    <details v-if="entry" class="advanced"><summary>联机诊断</summary>
      <p>任务 {{ entry.questId ?? '—' }} · 计划版本 {{ entry.revision ?? '—' }} · 柜台 {{ entry.transport }}</p>
      <p>当前任务 {{ entry.activeQuest ?? '—' }} · 原生任务人数 {{ entry.nativeQuestPlayerCount ?? '—' }}</p>
      <p v-if="run?.staged">出怪确认：UID {{ run.staged.uid }} / 槽位 {{ run.staged.slot }}</p>
      <p>有玩家离队、房主迁移或校验失败时，本局会停止并显示原因。可在“帮助与连接”下载双方日志；更新 DLL 后需重启游戏。</p>
    </details>
  </section>
</template>

<style scoped>
.entry-panel{line-height:1.8}.member-list{list-style:none;padding:0;max-width:600px}.member-list li{display:flex;justify-content:space-between;gap:16px;padding:10px 0;border-bottom:1px solid #443728}.entry-panel li{margin-bottom:8px}
</style>
