<script setup lang="ts">
import { computed } from 'vue';
import type { ConsoleState } from './api';
const props = defineProps<{ state: ConsoleState | null; connected: boolean; busy: boolean }>();
const emit = defineEmits<{ command: [cmd: string, extra: Record<string, unknown>] }>();
const dialogs = computed(() => (props.state?.ui?.dialogs ?? []).filter(d => d.kind === 'network_error' && !d.passive));
function close(token: string) {
  if (!props.connected || props.busy || !props.state?.ui?.sceneToken) return;
  const dialog = dialogs.value.find(d => d.token === token && d.supported && d.buttons?.includes('close'));
  if (dialog) emit('command', 'dialog.close', { sceneToken: props.state.ui.sceneToken, dialogToken: dialog.token });
}
</script>

<template>
  <section v-for="dialog in dialogs" :key="dialog.token" class="native-notice" role="alert" aria-label="游戏连接提示">
    <strong>游戏出现连接提示</strong>
    <p class="native-text">{{ dialog.text }}</p>
    <p>控制台能连接，并不代表游戏仍在联机大厅。关闭提示后，请在游戏信使处重新创建或加入大厅，再到“联机大厅”准备下一局。</p>
    <p v-if="state?.control?.startup.restorePending">个人装备与背包仍在恢复，请等恢复完成后再准备新局。</p>
    <button v-if="dialog.supported && dialog.buttons?.includes('close') && state?.ui?.sceneToken"
      :disabled="!connected || busy" @click="close(dialog.token)">关闭游戏提示</button>
    <p v-else>请先在游戏窗口中确认这条提示。</p>
  </section>
</template>

<style scoped>
.native-notice{border:1px solid #b79751;background:#302619;border-radius:8px;padding:16px;margin:16px 0;line-height:1.7}
.native-notice p{margin:8px 0}.native-text{white-space:pre-wrap}.native-notice button{min-height:44px}
</style>
