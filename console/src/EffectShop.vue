<script setup lang="ts">
import type { EffectDefinition, EffectOffer } from '../../src/core/effect_contract';
import type { EffectOrder } from '../../src/core/effect_orders';
import {readableEffectDescription} from './effect-model';
export interface EffectSnapshot {definitions:EffectDefinition[];offers:{offer:EffectOffer;description:string;canBuy:boolean;reason:string|null}[];orders:EffectOrder[];availablePt:number;reservedPt:number;message:string|null;run:string;blockedReason?:string|null;configuration?:{applies:'nextRun';nextRunPending:boolean};invalidProducts?:{id:string;name:string;reason:string}[];multiplayer?:{ready:boolean;busy:boolean;closed:boolean;reason:string}|null}
defineProps<{snapshot:EffectSnapshot|null|undefined;connected:boolean;busy:boolean;preparation?:{state:string;pending:boolean;reason:string}}>();
const emit=defineEmits<{command:[cmd:string,extra:Record<string,unknown>]}>();
const labels:Record<string,string>={reserved:'等待生效 · 可取消',locked:'已锁定 · 等待场地就绪',applying:'订单锁定 · 应用中',active:'生效中',suspended:'等待复活后恢复',cleaning:'清理中',ended:'交付／清理已核验',cancelled:'已取消',failed:'确认未交付',uncertain:'交付待核实',recovery:'恢复待办',retired:'恢复后封存（保留交付历史）'};
</script>
<template><section v-if="snapshot" class="panel"><h2>效果商店与订单 <span class="badge">实验</span></h2>
 <p><strong>可用 {{snapshot.availablePt}} PT</strong> · 待生效预留 {{snapshot.reservedPt}} PT</p>
 <p v-if="snapshot.message" class="alert">{{snapshot.message}}</p>
 <p v-if="snapshot.multiplayer" class="notice">联机效果：{{snapshot.multiplayer.closed?'会话已停止，请安全结束本局':!snapshot.multiplayer.ready?'等待全队连接确认':snapshot.multiplayer.busy?'交易核验中，尚未允许下一波':'全队已连接；购买者付款并获得效果，全队限购由房主统一确认'}}。</p>
 <div v-if="preparation?.pending" class="alert"><p>{{preparation.reason}}</p><p>场地可继续载入，战斗操作与怪物更新暂未放行。可处理订单，或安全停止本局。</p><button v-if="preparation.state==='blocked'" :disabled="!connected||busy" @click="emit('command','designerEffects',{sub:'continue'})">处理完成，重新核验并继续</button></div>
 <p v-if="snapshot.configuration?.nextRunPending" class="notice">策划已提交下一局的效果规则，本局仍按原商品成交。</p>
 <ul v-if="snapshot.invalidProducts?.length" class="alert"><li v-for="p in snapshot.invalidProducts" :key="p.id">{{p.name}}暂不可购买：{{p.reason}}</li></ul>
 <p class="muted">这里的购买会真实预留／扣除本局 PT，并修改游戏物资或属性。属性验证不等于每次伤害增加同样数值。</p>
 <div class="choice-grid"><article v-for="entry in snapshot.offers" :key="entry.offer.id" class="subpanel"><h3>{{entry.offer.name}}</h3><p>{{readableEffectDescription(entry.offer)}}</p><b>{{entry.offer.price}} PT</b><p v-if="entry.reason" class="muted">{{entry.reason}}</p><button :disabled="!connected||busy||!entry.canBuy" @click="emit('command','designerEffects',{sub:'buy',itemId:entry.offer.id,offerVersion:entry.offer.revision})">{{entry.offer.definition.delivery==='nextWave'?'预订下一波':'购买并核验交付'}}</button></article></div>
 <article v-for="order in [...(snapshot.orders??[])].reverse()" :key="order.id" class="effect-order"><h3>{{order.offer.name}} · {{labels[order.state]}}</h3><p>{{order.message}}</p><p v-if="order.evidence">执行核验：{{order.evidence.message}}</p><p v-if="order.cleanup">清理核验：{{order.cleanup.message}}</p><small>第 {{order.context.layer}} 层 · 价格 {{order.offer.price}} PT · {{order.charged?'已扣款':'尚未扣款'}} · {{order.context.wave}}</small><div class="toolbar"><button v-if="order.state==='failed'" :disabled="!connected||busy" @click="emit('command','designerEffects',{sub:'dismiss',orderId:order.id})">确认未交付并放弃此订单</button><button v-if="order.state==='reserved'" :disabled="!connected||busy" @click="emit('command','designerEffects',{sub:'cancel',orderId:order.id})">取消预订</button><button v-if="['uncertain','recovery'].includes(order.state)" :disabled="!connected||busy" @click="emit('command','designerEffects',{sub:'inspect',orderId:order.id})">只读核实交付</button><button v-if="order.state==='recovery'" :disabled="!connected||busy" @click="emit('command','designerEffects',{sub:'cleanup',orderId:order.id})">核验并清理（安全阶段）</button></div></article>
</section></template>
<style scoped>.effect-order{border-top:1px solid #655236;margin-top:16px;padding-top:12px}.effect-order small{overflow-wrap:anywhere;opacity:.7}</style>
