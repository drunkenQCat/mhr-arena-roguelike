<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { getJson } from './api';
defineProps<{ developer: boolean }>();
const emit = defineEmits<{ 'update:developer': [value: boolean] }>();
interface Connection { localUrl: string; addresses: { adapter: string; url: string }[]; enumerationOk: boolean }
const connection = ref<Connection | null>(null), message = ref(''), loading = ref(false);
async function refresh() {
  loading.value = true;
  try { connection.value = await getJson<Connection>('/api/connection', AbortSignal.timeout(3000)); message.value = ''; }
  catch { message.value = '暂时无法读取手机地址。更新过模组后请完全退出并重开游戏；仍无地址时，按下方方法在 Windows 中查看 IPv4。'; }
  finally { loading.value = false; }
}
async function copy(url: string) {
  try { await navigator.clipboard.writeText(url); message.value = '地址已复制。可发送到自己的手机，再用手机浏览器打开。'; }
  catch { message.value = '浏览器不允许自动复制，请长按或选中下面的完整地址手动复制。'; }
}
onMounted(refresh);
</script>

<template>
  <section class="panel connection-help">
    <h2>第一次使用，从这里开始</h2>
    <p>这是运行在游戏里的控制台，不用安装 Node.js，也不用另外启动服务器。游戏关闭后，本页面的按钮就不能操作游戏。</p>
    <ol>
      <li>先在 Steam 中启动《怪物猎人：崛起》，选好存档，进入村庄。</li>
      <li>在电脑浏览器打开 <a href="http://127.0.0.1:11777/console">http://127.0.0.1:11777/console</a>。这个地址只代表当前这台电脑。</li>
      <li>上方显示“已连接游戏”后，切到“当前局”。单人选择开局防具后开始；与朋友联机则进入“联机大厅”，按房主／队友提示入场。</li>
      <li>清波后回到本任务起点，等待剥取和集结计时结束，再购物或选下一波。结束本局后，按游戏画面提示完成结算并回村。</li>
    </ol>
    <h2>用手机控制，不用先学网络术语</h2>
    <p>让手机和游戏电脑连接同一个路由器：手机连家里的 Wi-Fi，电脑可以连这个 Wi-Fi，也可以插这个路由器的网线。这就是这里说的“同一局域网”。手机只开移动数据，或者连访客 Wi-Fi，通常不行。</p>
    <ol>
      <li>先确认电脑上的控制台能正常打开。</li>
      <li>保持游戏开启，在手机浏览器里输入下面的<strong>完整地址</strong>，包含 <code>http://</code>、<code>:11777</code> 和 <code>/console</code>。不要输入到搜索框。</li>
      <li>若有多个地址，先试名称为 Wi-Fi 或以太网的那一个。换 Wi-Fi、重启路由器后地址可能变化，回来刷新即可。</li>
    </ol>
    <button :disabled="loading" @click="refresh">{{ loading ? '正在查找…' : '刷新手机访问地址' }}</button>
    <article v-for="item in connection?.addresses ?? []" :key="item.url" class="phone-address">
      <strong>{{ item.adapter || '已连接的网络' }}</strong>
      <a :href="item.url" class="phone-url">{{ item.url }}</a><button @click="copy(item.url)">复制这个地址</button>
    </article>
    <p v-if="connection && !connection.addresses.length">没有找到可用的网线 / Wi-Fi 地址。请检查电脑网络，或按下方手动查看。</p>
    <p v-if="message" class="notice" role="status">{{ message }}</p>
    <p class="muted">手机不能用 127.0.0.1；那在手机上指的是手机自己。0.0.0.0 是程序监听设置，也不是要输入的访问地址。</p>
    <details><summary>没有显示地址？在 Windows 中手动找 IPv4</summary>
      <ol><li>点击电脑“开始”→“设置”→“网络和 Internet”。</li><li>使用网线就点“以太网”；使用无线就点“Wi-Fi”→当前连接的网络 / 硬件属性。</li><li>找到“IPv4 地址”（例如 192.168.1.25），不要选默认网关、DNS 或 IPv6。</li><li>将它放入 <code>http://你的IPv4地址:11777/console</code>，在手机浏览器打开。</li></ol>
    </details>
    <details><summary>电脑能打开，手机打不开怎么办？</summary>
      <ol><li>手机关闭移动数据再试，确认没有连“访客网络”；电脑和手机应在同一个家用路由器下。</li><li>暂时断开 VPN / 代理，再刷新电脑的地址列表。</li><li>检查 Windows 防火墙是否允许游戏接收局域网连接。不要关闭整个防火墙；发行包“使用说明.txt”提供仅针对端口 11777 的操作与撤销方法。</li><li>学校、公司或酒店 Wi-Fi 可能禁止设备互相访问。换可信的家用网络，不要给路由器做公网端口转发。</li></ol>
    </details>
    <details><summary>游戏连不上，或卡在结算画面？</summary>
      <p>确认文件放在 MonsterHunterRise.exe 旁边，而不是多套一层压缩包文件夹。更新 DLL 后必须完全退出并重开游戏。若界面提示状态过期，先回游戏查看是否加载中；截图背景页显示“F 前进”时，先按 F 继续。不要在战斗中重置脚本。</p>
      <p>失败交易显示“结果待核实”时，先检查背包与命令记录，不要连续购买。需要反馈时到“更多工具 → 命令记录”导出记录，同时附上当前游戏画面和发行包版本。</p>
    </details>
    <details><summary>策划与开发者</summary>
      <p>“更多工具 → 策划工作台”可以改数值；先导出备份，再修改并提交。当前波次不会被重算，部分规则下一局生效。实验探针不随发行包自动启动，需要时由维护者使用 CLI 的 game run-script 按次执行。</p>
      <label class="check"><input type="checkbox" :checked="developer" @change="emit('update:developer', ($event.target as HTMLInputElement).checked)">显示无敌、传送、快速击杀等开发测试工具（本次页面有效）</label>
    </details>
  </section>
</template>

<style scoped>
.connection-help{line-height:1.8;margin-bottom:20px}.connection-help h2:not(:first-child){margin-top:28px}.connection-help li{margin:8px 0}.connection-help a{color:#f0ce86;overflow-wrap:anywhere}.connection-help code{overflow-wrap:anywhere}.phone-address{display:flex;align-items:center;flex-wrap:wrap;gap:12px;padding:16px 0;border-bottom:1px solid #4a3e2c}.phone-url{user-select:all;font-family:Consolas,monospace}.connection-help details{margin-top:20px}.connection-help details p{margin-top:12px}
</style>
