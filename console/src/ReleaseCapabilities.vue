<script setup lang="ts">
import capabilities from '../../data/release_capabilities.json';
</script>
<template>
  <section class="panel compact-panel" aria-label="版本能力与验收范围">
    <h2>版本能力与验收范围</h2>
    <p>{{ capabilities.playerSummary }}</p>
    <p>{{ capabilities.verificationSummary }}</p>
    <p>仍需验证：</p>
    <ul><li v-for="gate in capabilities.remainingGates" :key="gate.id">{{ gate.label }}</li></ul>
    <small>这些是本构建的已记录验收范围，不代表当前大厅已验证。反馈时请附双方日志。</small>
  </section>
</template>
