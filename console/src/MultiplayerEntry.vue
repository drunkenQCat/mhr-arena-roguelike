<script setup lang="ts">
import type { ConsoleState } from "./api";
defineProps<{ entry: ConsoleState["multiplayerEntry"]; run?: ConsoleState["multiplayerRun"]; busy: boolean }>();
const emit = defineEmits<{ command: [cmd: string, extra: Record<string, unknown>] }>();
</script>
<template>
  <section class="panel">
    <div v-if="run" class="notice">
      <h2>局内联机 · {{ run.role === 'host' ? '房主' : '队友' }}</h2>
      <p>{{ run.message }}</p>
      <p>选波由房主操作；每人使用自己电脑上的控制台购物，个人 PT 和背包独立。猫车恢复由房主购买。</p>
      <ul><li v-for="member in run.members ?? []" :key="member.id">{{ member.self ? '本机' : member.id }}：{{ member.ready ? '状态已确认' : '等待同步' }}</li></ul>
      <p v-if="run.staged">出怪确认：UID {{ run.staged.uid }} / 槽位 {{ run.staged.slot }}</p>
      <p class="alert">双客户端仍需实测；有玩家离队、房主迁移或状态校验失败时，本局会停止并显示原因，请下载双方日志。</p>
    </div>
    <h2>真实队友 · Steam 自动同步入场</h2>
    <p>房主选择入场波次，队友自动准备相同任务表；进入斗技场后自动接入局内循环。保留自己的装备与背包，后续清波 PT 每人独立结算。</p>
    <p class="alert">双客户端共同入场仍待验收。所有人安装同一个新版包，只在约好的私人大厅测试。</p>
    <ol>
      <li>各自启动游戏并打开自己电脑的控制台，通过游戏信使创建／加入同一个在线大厅。</li>
      <li>大厅房主在下方选波；队友无需选怪、复制任务码或输入 IP。等待全队显示“任务表一致”。</li>
      <li>房主点“承接联机任务”。全队会再确认一次；确认齐全后才打开柜台。队友从原生任务板加入。</li>
      <li>在游戏内确认参战名单齐全并准备完成，房主手动出发。网页不会提前出发。</li>
    </ol>
    <p>原生身份：<strong>{{ entry?.role === 'host' ? '大厅房主' : entry?.role === 'guest' ? '大厅队友' : '尚未进入在线大厅' }}</strong></p>
    <p v-if="entry && !entry.sync.available" class="alert">{{ entry.sync.reason }}</p>
    <p v-else-if="entry && !entry.sync.lobby" class="muted">等待 Steam 大厅；若已在大厅，请退出大厅后重新加入，让模组识别当前会话。</p>
    <p v-if="!entry?.canPrepare" class="alert">先结束单人局并回村，等待原装备、背包恢复。</p>
    <div v-if="entry?.role === 'host'" class="toolbar">
      <button v-for="option in entry.options ?? []" :key="option.index" :disabled="busy || !entry.canPrepare || entry.playing || entry.posting || !entry.sync.available" @click="emit('command', 'mpEntry', { sub: 'choose', index: option.index })">{{ option.label }}</button>
    </div>
    <p>当前波次 {{ entry?.mode ?? '房主尚未选择' }} · 任务 {{ entry?.questId ?? 900103 }} · 计划版本 {{ entry?.revision ?? '—' }}</p>
    <ul v-if="entry?.sync.members?.length">
      <li v-for="member in entry.sync.members" :key="member.id">{{ member.self ? '本机' : '队友' }} {{ member.id }}：<strong>{{ member.ready ? '任务表一致' : '等待准备／版本不符' }}</strong></li>
    </ul>
    <button v-if="entry?.role === 'guest'" :disabled="busy || !entry.canPrepare || entry.playing" @click="emit('command', 'mpEntry', { sub: 'retrySync' })">重试自动同步</button>
    <button v-if="entry?.role === 'host'" :disabled="busy || !entry.canPost || !entry.canPrepare || entry.playing || entry.posting" @click="emit('command', 'mpEntry', { sub: 'post' })">承接联机任务（等待全队确认，不自动出发）</button>
    <p class="notice">{{ entry?.message ?? '等待游戏加载新版 Lua。' }}</p>
    <p class="muted">至少两名真实 Steam 大厅成员全部确认才能承接。当前任务 {{ entry?.activeQuest ?? '—' }} · 原生任务人数 {{ entry?.nativeQuestPlayerCount ?? '—' }} · 柜台 {{ entry?.transport ?? '—' }}。更新 DLL 后需重启游戏。详情见包内《测试与反馈》。</p>
  </section>
</template>
