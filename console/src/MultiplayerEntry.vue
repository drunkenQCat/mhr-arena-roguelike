<script setup lang="ts">
import { ref } from "vue";
import type { ConsoleState } from "./api";
defineProps<{ entry: ConsoleState["multiplayerEntry"]; busy: boolean }>();
const emit = defineEmits<{ command: [cmd: string, extra: Record<string, unknown>] }>();
const code = ref("");
</script>

<template>
  <section class="panel">
    <h2>真实队友 · 联机入场实验</h2>
    <p>本次只验证：大厅房主选怪，队友加入同一任务并一起进入斗技场。保留自己的装备与背包，不开启单人肉鸽，不发 PT，不自动续波。</p>
    <p class="alert">尚未完成双客户端验收。先用备份过的存档，在约好的私人大厅测试。不要对陌生人的任务使用。</p>
    <ol>
      <li>所有人安装同一个 Release。各自在自己电脑打开控制台。通过游戏信使创建／加入同一个在线大厅。</li>
      <li>大厅房主在下方选一个波次，把显示的任务码发给队友。队友粘贴任务码并点“准备任务表”。每人都检查任务码完全相同。</li>
      <li>房主点“承接联机任务”。队友在游戏的任务板加入房主任务。若找不到、提示无此任务或怪物不同，请停止并导出状态。</li>
      <li>在游戏内确认所有队友已加入并准备，再由房主手动出发。网页不会提前出发。</li>
    </ol>
    <p>原生身份：<strong>{{ entry?.role === 'host' ? '大厅房主' : entry?.role === 'guest' ? '大厅队友' : '尚未进入在线大厅' }}</strong> · 本人 {{ entry?.self ?? '—' }} / 房主 {{ entry?.host ?? '—' }}</p>
    <p v-if="!entry?.canPrepare" class="alert">先结束单人局并回村，等待原装备、背包恢复。</p>
    <div v-if="entry?.role === 'host'" class="toolbar">
      <button v-for="option in entry.options ?? []" :key="option.index" :disabled="busy || !entry.canPrepare || entry.playing" @click="emit('command', 'mpEntry', { sub: 'choose', index: option.index })">{{ option.label }}</button>
    </div>
    <div v-if="entry?.role === 'guest'" class="toolbar">
      <label>房主发来的任务码 <input v-model="code" placeholder="MHR-ENTRY-1-S" maxlength="40" /></label>
      <button :disabled="busy || !entry.canPrepare || entry.playing" @click="emit('command', 'mpEntry', { sub: 'import', entryCode: code.trim() })">准备任务表</button>
    </div>
    <p>本机任务码：<strong class="mono">{{ entry?.code ?? '未准备' }}</strong> · 任务编号 {{ entry?.questId ?? 900103 }}</p>
    <p v-if="entry?.code && !entry.planMatchesLobby" class="alert">大厅身份已变化，请重新选择／导入任务码。</p>
    <button v-if="entry?.role === 'host'" :disabled="busy || !entry.code || !entry.planMatchesLobby || !entry.canPrepare || entry.playing || entry.transport !== 'Idle'" @click="emit('command', 'mpEntry', { sub: 'post' })">承接联机任务（不自动出发）</button>
    <p class="notice">{{ entry?.message ?? '等待游戏加载新版 Lua。' }}</p>
    <p class="muted">当前原生任务 {{ entry?.activeQuest ?? '—' }} · {{ entry?.playing ? '正在任务中' : '未在战斗' }} · 承接阶段 {{ entry?.transport ?? '—' }}。原生任务人数 {{ entry?.nativeQuestPlayerCount ?? '—' }}。任务码是本版固定怪物表，不是联机密码；两端必须同版本。详情见压缩包内《测试与反馈》。</p>
  </section>
</template>
