<script setup lang="ts">
import { ref } from 'vue';
const message = ref(''), downloading = ref(false);
async function download() {
  downloading.value = true;
  try {
    const response = await fetch('/api/diagnostics', { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement('a');
    link.href = url; link.download = `MHR-support-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    message.value = '日志已下载，请从浏览器下载列表把这个 JSON 文件发给测试组织者。';
  } catch { message.value = '下载失败。请保持游戏开启，确认控制台连接正常后再试；崩溃时请先拍下画面。'; }
  finally { downloading.value = false; }
}
</script>

<template>
  <section class="panel support-bar">
    <div class="section-heading"><div><strong>遇到问题 · 下载测试日志</strong><small>包含版本、游戏状态、操作记录和最近错误，可能含玩家标识与本机路径；不含存档、密码。仅在点击时读取。</small></div>
      <button :disabled="downloading" @click="download">{{ downloading ? '正在收集…' : '下载测试日志' }}</button>
    </div>
    <p v-if="message" role="status" class="notice">{{ message }}</p>
  </section>
</template>

<style scoped>
.support-bar{margin:16px 0}.support-bar strong{line-height:1.7}
</style>
