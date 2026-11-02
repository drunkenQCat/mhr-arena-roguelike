<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { getJson } from './api';

const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const addresses = ref<{ adapter: string; url: string }[]>([]);
const message = ref(''), downloading = ref(false);
async function refresh() {
  try {
    const data = await getJson<{ addresses: { adapter: string; url: string }[] }>('/api/connection', AbortSignal.timeout(3000));
    addresses.value = data.addresses ?? [];
  } catch { message.value = '暂时无法读取手机地址，请到“安装与手机连接”查看手动步骤。'; }
}
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
onMounted(() => { if (!mobile) void refresh(); });
</script>

<template>
  <section class="panel support-bar">
    <div class="section-heading"><div><strong>测试出问题？一键下载日志发给我</strong><small>包含版本、游戏状态、操作记录和最近错误，可能含玩家标识与本机路径；不含存档、密码。仅在点击时读取。</small></div>
      <button class="primary" :disabled="downloading" @click="download">{{ downloading ? '正在收集…' : '下载测试日志' }}</button>
    </div>
    <div v-if="!mobile" class="phone-tip">
      <h3>可以用手机控制，不必切出游戏</h3>
      <p>手机连上与这台电脑同一个路由器的 Wi-Fi（电脑可以插网线），在手机浏览器打开下面的完整地址。不要在手机输入 localhost。</p>
      <p v-for="item in addresses" :key="item.url"><strong>{{ item.adapter }}：</strong><a :href="item.url">{{ item.url }}</a></p>
      <p v-if="!addresses.length">未找到地址：点“安装与手机连接”查看如何找到电脑的 IPv4 地址。</p>
      <button @click="refresh">刷新手机地址</button>
      <details><summary>电脑能打开，手机打不开？先看防火墙提示</summary>
        <p>Windows 弹出联网许可时，家庭网络请允许专用网络。不要关闭整个防火墙。若之前点了取消，打开“Windows 安全中心 → 防火墙和网络保护 → 允许应用通过防火墙 → 更改设置”，允许 MonsterHunterRise.exe 的专用网络；也可按“安装与手机连接”的步骤只放行 TCP 11777。</p>
        <p>关闭手机移动数据试试；不要连接访客 Wi-Fi。学校、公司、酒店网络可能隔离设备，请换家庭网络。朋友在别的家时，使用他自己电脑的控制台；不需要端口转发。</p>
      </details>
    </div>
    <p v-if="message" role="status" class="notice">{{ message }}</p>
  </section>
</template>

<style scoped>
.support-bar{margin:16px 0;border-color:#b68b42}.phone-tip{border-top:1px solid #655237;margin-top:15px;line-height:1.7}.phone-tip a{color:#f0ce86;user-select:all;overflow-wrap:anywhere}.phone-tip details{margin-top:12px}.support-bar strong{line-height:1.7}
</style>
