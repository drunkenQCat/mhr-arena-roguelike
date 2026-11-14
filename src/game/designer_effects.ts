import { EffectOrders, type EffectOrder, type EffectContext, type EffectEvidence } from "../core/effect_orders";
import { copyEffectValue, effectDescription, type EffectOffer, type EffectDefinition } from "../core/effect_contract";
import type { RogueConfig } from "../core/config";
import type { RunSession } from "../core/run_session";
import type { GachaService } from "./gacha";
import { EffectCatalog } from "./effect_catalog";
import { canonical } from "./wire_canonical";
import { getSingleton, clockSeconds, loadWebconsole, type REManagedObject } from "./sdk";
import { readRecoveryOwner, assertRecoveryOwner, type RecoveryOwner } from "./recovery_owner";
import { writeRecoveryRecord, readRecoveryRecord } from "./recovery_journal";
import { grantItem, pouchCount, pouchCanReceive, canTrade } from "./item_grant";
import {EffectParticipant,type EffectParticipantJournal} from '../core/effect_participant';
import {steamMailbox} from './steam_mailbox';
import type {RunContext} from './multiplayer_run';
import {enqueueEquipmentWork,cancelEquipmentWork} from './equipment_update';

const JOURNAL = "mhw_rogue_effect_orders.json";
interface EffectJournal { active:boolean;schema:1;owner:RecoveryOwner;run:string;orders:EffectOrder[];charged:string[] }
const NETWORK_JOURNAL='mhw_rogue_effect_network.json';
interface NetworkJournal {active:boolean;schema:1;owner:RecoveryOwner;network:EffectParticipantJournal}
const unknown = (message:string):EffectEvidence => ({status:"unknown",verification:"attribute",message});
const localPlayer=():REManagedObject|null => getSingleton("snow.player.PlayerManager")?.call("findMasterPlayer") as REManagedObject|null;
const data=():REManagedObject|null => localPlayer()?.call("get_PlayerData") as REManagedObject|null;

/** Experimental designer service: local transactions share the real wallet and recovery lifecycle. */
export class DesignerEffects {
  readonly catalog = new EffectCatalog();
  private engine:EffectOrders|null=null;
  private owner:RecoveryOwner|null=null;
  private run="";
  private serial=0;
  private charged:string[]=[];
  private records:Record<string,EffectEvidence>={};
  private notice:string|null=null;
  private invalidProducts:{id:string;name:string;reason:string}[]=[];
  private lastLayer=0;
  private lastTick=-1;
  private lifecycle="";
  private ended=false;
  private nativeQuestUniqueOverride:number|null=null;
  private multiplayer:RunContext|null=null;
  private peer:EffectParticipant|null=null;
  private executingPermit=false;
  private readonly peerWork={};
  constructor(private readonly session:()=>RunSession,private readonly config:()=>RogueConfig,private readonly gacha:GachaService,
    private readonly legacyConflict:(group:string)=>string|null=()=>null) {}
  initialize(): void { this.catalog.load(); }
  attachMultiplayer(context:RunContext):void{
    if((this.session().core.config.effectShop?.products.length??0)===0)return;
    if(this.multiplayer){if(canonical(this.multiplayer)!==canonical(context))throw new Error('联机效果房间身份改变，须安全结束原局');return;}
    if(this.engine&&!this.ended&&this.engine.snapshot().length>0)throw new Error('仍有离线效果订单，不能切换到联机账本');
    const previous=readRecoveryRecord<NetworkJournal>(NETWORK_JOURNAL);
    if(previous?.active){assertRecoveryOwner(previous.owner);throw new Error('上次联机效果授权尚待恢复与原生保存，不能重放许可');}
    this.multiplayer=copyEffectValue(context);this.engine=null;this.start();
    const network=loadWebconsole();
    const identity={...context,epoch:`${network.session_id?.()}-${network.epoch()}`};
    const digest=(v:unknown)=>{const value=network.steam_digest?.(canonical(v));if(!value||value.length!==64)throw new Error('联机效果摘要不可用');return value;};
    this.peer=new EffectParticipant(identity,{
      now:clockSeconds,boundary:()=>({layer:this.session().core.state.layer,token:this.session().plan?.token??0,
        phase:this.scopePhase(),accepting:['Preparing','Selecting','Carve'].includes(this.session().stage)}),
      context:()=>this.scope(),balance:()=>this.session().core.state.wallet.pt,orders:()=>this.engine!.snapshot(),
      offer:id=>{const cfg=this.session().core.config.effectShop;const product=cfg?.products.find(p=>p.id===id);
        if(!cfg||!product)throw new Error('效果商品不存在');return this.catalog.offer(product,cfg.groups);},
      reserve:(offer,c,id)=>{this.executingPermit=true;try{return this.engine!.reserve(offer,offer.revision,c,id);}finally{this.executingPermit=false;}},
      cancel:id=>this.engine!.cancel(id,context.self),fingerprint:digest,
      persist:state=>{if(!this.owner||!writeRecoveryRecord(NETWORK_JOURNAL,{active:!state.retirement&&(state.actions.length>0||(state.authority?.orders.length??0)>0),schema:1,
        owner:this.owner,network:state}))throw new Error('联机效果授权日志写入或读回失败，禁止重放');},
      network:(dispatch,fail)=>steamMailbox(identity,'effects_v1',dispatch,fail),
    });
  }
  private scopePhase():EffectContext['phase']{return this.session().stage==='PreparingCombat'?'Preparing':this.session().stage as EffectContext['phase'];}
  multiplayerAttached():boolean{return this.peer!==null;}
  private cleanupDue():boolean{
    const s=this.session();return (this.engine?.snapshot()??[]).some(o=>o.context.run===this.run&&
      (o.context.layer<s.core.state.layer||s.stage==='Carve'&&o.context.layer===s.core.state.layer)&&
      ['reserved','locked','applying','active','suspended','cleaning','uncertain','recovery'].includes(o.state));
  }
  transactionBusy():boolean{return this.cleanupDue()||this.peer!==null&&(!this.peer.diagnostic().ready||this.peer.busy()||this.peer.diagnostic().closed);}
  commandResult(id:string):unknown{return this.peer?.result(id)??null;}
  private scope():EffectContext {
    const s=this.session(),r=s.readingSnapshot;
    if (!this.engine || !this.run || !s.startupStatus.prepared || !r || !["Preparing","PreparingCombat","Selecting","Carve","Combat"].includes(s.stage)) throw new Error("请先开始本局并进入支持的阶段");
    if (r.online&&!this.peer) throw new Error("效果实验当前仅允许本机单人；真实全队事务接线验收前不放行联机购买");
    const player=getSingleton("snow.player.PlayerManager")?.call("findMasterPlayer") as REManagedObject|null;
    // PlayerWeaponType differs from data.weapon.WeaponTypes and GUI enums.
    // Verified on PlayerLobbyBase in Instance1: LongSword reads 2.
    let weapon=-1; try {const value=player?.get_field("_playerWeaponType");if(typeof value==="number"&&Number.isInteger(value)&&value>=0&&value<=13)weapon=value;}catch { /* Restricted products reject unknown. */ }
    return {run:this.run,player:this.multiplayer?.self??"local",team:this.multiplayer?.members??["local"],layer:s.core.state.layer,wave:`${this.run}/wave-${s.core.state.layer}`,
      phase:this.scopePhase(),weapon};
  }
  private persist(orders:EffectOrder[]):void {
    if (!this.owner) throw new Error("缺少本局角色归属");
    const current=readRecoveryOwner();
    if(current.character!==this.owner.character||current.slot!==this.owner.slot||current.process!==this.owner.process)throw new Error("效果订单角色或进程已变化");
    if (!writeRecoveryRecord(JOURNAL,{active:orders.some(o=>!["ended","cancelled","failed","retired"].includes(o.state)),schema:1,
      owner:this.owner,run:this.run,orders,charged:this.charged})) throw new Error("效果订单持久化失败；未确认操作不自动重放");
  }
  private start():void {
    const previous=readRecoveryRecord<EffectJournal>(JOURNAL);
    if(previous?.active){
      assertRecoveryOwner(previous.owner);
      if(previous.schema!==1||!Array.isArray(previous.orders)||previous.orders.some(o=>!["reserved","locked","cancelled","failed","ended","retired"].includes(o.state)))
        throw new Error("存在上次效果交付或清理待办；保留记录，不能重放执行");
      // Applying is journaled BEFORE any native execution. A durable reserved
      // order is proven unexecuted and may be cancelled after a reset.
      for(const order of previous.orders)if(["reserved","locked"].includes(order.state)){order.state="cancelled";order.message="上局已中断且订单尚未应用，释放原预留；未扣款";}
      if(!writeRecoveryRecord(JOURNAL,{...previous,active:false}))throw new Error("上局未应用订单封存失败，保留备份");
    }
    this.owner=readRecoveryOwner();this.run=this.multiplayer?.session??`${this.owner.process}/effects-${loadWebconsole().epoch()}-${clockSeconds()}-${++this.serial}`;this.charged=[];this.records={};this.lastLayer=0;this.ended=false;this.notice=null;
    this.engine=new EffectOrders({balance:()=>this.session().core.state.wallet.pt,
      charge:o=>{if(this.charged.includes(o.id))return;const wallet=this.session().core.state.wallet;
        if(wallet.pt<o.offer.price)throw new Error("权威钱包余额不足");
        wallet.pt-=o.offer.price;wallet.purchaseLog=wallet.purchaseLog.concat([o.offer.id]);this.charged.push(o.id);},
      check:(offer)=>this.blockingReason()??this.legacyConflict(offer.definition.group)??(offer.definition.delivery==="instant"&&!canTrade(this.tradeContext())?"当前原生任务、怪物或背包状态不允许发货":this.catalog.program(offer.definition.implementation).check(this.programApi(offer.definition,"check"),offer.effect.parameters)),
      apply:o=>{const result=this.catalog.program(o.offer.definition.implementation).apply(this.programApi(o.offer.definition,"apply"),o.offer.effect.parameters);this.records[o.id]=copyEffectValue(result);return result;},
      inspect:o=>this.catalog.program(o.offer.definition.implementation).inspect(this.programApi(o.offer.definition,"inspect"),o.offer.effect.parameters,o.evidence??this.records[o.id]),
      remove:o=>this.catalog.program(o.offer.definition.implementation).remove(this.programApi(o.offer.definition,"remove",undefined,o),o.offer.effect.parameters,o.evidence),
      rebind:(o,retainedGroupAfter)=>{const p=this.catalog.program(o.offer.definition.implementation);if(!p.rebind)return unknown("冻结实现未声明原生重建能力");return p.rebind(this.programApi(o.offer.definition,"rebind",retainedGroupAfter),o.offer.effect.parameters,o.evidence);},
      persist:o=>this.persist(o),fingerprint:canonical});
  }
  private stat(field:string):number {
    if (!["_AtkUpAlive","_DefUpAlive"].includes(field)) throw new Error("效果未获该字段能力");
    const value=data()?.get_field(field);if(typeof value!=="number"||!Number.isFinite(value))throw new Error("玩家加成字段不可读");return value;
  }
  private nativeContext():string {
    const s=this.session(),r=s.readingSnapshot,d=data();if(!d)throw new Error("原生玩家属性尚未就绪");
    const deaths=localPlayer()?.call("getDieCount");
    if(typeof deaths!=="number"||!Number.isInteger(deaths)||deaths<0)throw new Error("本机原生死亡代数不可读");
    // Shared cart counts can decrease after a recovery purchase, or increase
    // because another player fainted. Neither means this actor was rebuilt.
    return `${this.owner?.process}|${this.nativeQuestUniqueOverride??r?.quest?.unique??"village"}|${d.get_address()}|${deaths}`;
  }
  private programApi(definition:EffectDefinition,operation:"check"|"apply"|"inspect"|"remove"|"rebind",retainedGroupAfter?:number,cleanupFor?:EffectOrder){
    const api=this.api(retainedGroupAfter,cleanupFor);
    const attribute=definition.recoveryScope==="runtimeAttribute"||["attack.flat","defense.flat"].includes(definition.id);
    const inventory=definition.recoveryScope==="inventory"||["item.grant","equipment.roll"].includes(definition.id);
    const permitted:Record<string,boolean>={add_stat:operation==="apply"&&attribute,
      rebind_stat:operation==="rebind"&&attribute&&definition.rebindOnNativeReset===true,
      restore_stat:operation==="remove"&&attribute,
      grant_item:operation==="apply"&&inventory&&definition.delivery==="instant",
      roll_gacha:operation==="apply"&&inventory&&definition.delivery==="instant"};
    for(const key of Object.keys(permitted))if(!permitted[key])api[key]=()=>{throw new Error(`效果 ${definition.id} 的 ${operation} 阶段无 ${key} 写入权限`);};
    return api;
  }
  private tradeContext(){
    // Separate declarations: TSTL hoists optional-chain temporaries ahead of
    // the entire declaration list, which would read a global `s` here.
    const s=this.session();
    const q=s.readingSnapshot?.quest;
    return s.stage==="Carve"&&q?.playing?{questId:q.id,questUnique:q.unique,...(this.multiplayer?{multiplayer:true}:{})}:s.shopQuest();
  }
  private addStat(field:string,amount:number):EffectEvidence {
    const before=this.stat(field),after=before+amount,player=data();if(!player)return {status:"not-applied",verification:"attribute",message:"玩家对象不可用，未写入"};
    const nativeContext=this.nativeContext();player.set_field(field,after);const observed=this.stat(field);
    return {status:observed===after?"applied":"unknown",verification:"attribute",before,after:observed,
      message:`${field} ${before} → ${observed}（字段核验，不代表固定伤害增量）`,
      handle:{field,before,after,process:this.owner!.process,nativeContext,dataAddress:player.get_address()}};
  }
  private api(retainedGroupAfter?:number,cleanupFor?:EffectOrder):Record<string,(this:void,...args:any[])=>any> {
    // Explicit plain callbacks: Lua invokes api.read_stat(...), not a TS method.
    return {
      check_stat:(field:string,amount:number)=>{try {this.stat(field);return amount>0?null:"加成必须为正";}catch(e){return String(e);}},
      add_stat:(field:string,amount:number)=>this.addStat(field,amount),
      rebind_stat:(receipt:EffectEvidence|undefined,amount:number):EffectEvidence=>{
        const h=receipt?.handle;if(!h||typeof h.nativeContext!=="string")return unknown("旧回执缺少原生实例身份，不能重放属性写入");
        const current=this.nativeContext(),value=this.stat(String(h.field));
        if(retainedGroupAfter!==undefined&&value===retainedGroupAfter&&data()?.get_address()===h.dataAddress)
          return {...receipt!,handle:{...h,nativeContext:current,groupObserved:value},message:`整组原属性仍为 ${value}，已核验保留；没有重复添加`};
        if(current===h.nativeContext)return value===h.after?receipt!:unknown("原生实例未变但字段被其他系统修改，不自动覆盖");
        if(value===h.after&&data()?.get_address()===h.dataAddress)return {...receipt!,handle:{...h,nativeContext:current},message:"原属性仍存在，已更新原生上下文；没有重复添加"};
        if(value!==h.before)return unknown(`原生重建后基线 ${value} 与原回执 ${h.before} 不同，不能猜测增益归属`);
        return this.addStat(String(h.field),amount);
      },
      inspect_stat:(receipt?:EffectEvidence):EffectEvidence=>{const h=receipt?.handle;if(!h)return unknown("缺少原始写入回执");
        if(h.process!==readRecoveryOwner().process)return unknown("原进程已退出，不能核实原交付；请通过原资源恢复与保存封存历史");
        if(h.dataAddress!==data()?.get_address()||h.nativeContext!==this.nativeContext())return unknown("原属性实例或原生上下文已变化，当前字段不能证明原订单交付");
        const value=this.stat(String(h.field));return {...receipt!,status:value===h.after?"applied":value===h.before?"not-applied":"unknown",message:`实际字段 ${value}`};},
      restore_stat:(receipt?:EffectEvidence):EffectEvidence=>{const h=receipt?.handle;if(!h)return unknown("缺少清理所有权回执");
        if(h.process!==readRecoveryOwner().process)return {status:"applied",verification:"attribute",message:"原进程退出，临时属性对象已销毁"};
        const currentData=data();if(!currentData)return unknown("原生角色暂不可读，不能将暂时缺席视作属性对象已销毁");
        if(typeof h.dataAddress==="number"&&currentData.get_address()!==h.dataAddress)return {status:"applied",verification:"attribute",message:"原属性对象已被原生替换，不写入新角色对象"};
        const before=this.stat(String(h.field));if(before===h.before)return {status:"applied",verification:"attribute",before,after:before,message:"原生已恢复该字段"};
        if(cleanupFor&&h.nativeContext!==this.nativeContext()){
          const first=this.engine?.snapshot().find(o=>o.context.run===cleanupFor.context.run&&o.context.wave===cleanupFor.context.wave&&
            o.evidence?.handle?.field===h.field&&o.evidence?.handle?.dataAddress===h.dataAddress);
          if(first?.evidence?.handle?.before===before)return {status:"applied",verification:"attribute",before,after:before,message:"原生重建后字段已回到本波整组基线；全部贡献已清除，不重复写入"};
        }
        if(before!==h.after)return unknown("字段被其他系统改写，保留待办，不覆盖原生增益");
        data()!.set_field(String(h.field),h.before);const after=this.stat(String(h.field));
        return {status:after===h.before?"applied":"unknown",verification:"attribute",before,after,message:`清理字段 ${before} → ${after}`};},
      check_item:(id:number)=>pouchCanReceive(`native_item_${id}`)?null:"道具不可携带、背包已满或原生容量不足",
      grant_item:(id:number,count:number):EffectEvidence=>{const r=grantItem(`native_item_${id}`,count,this.tradeContext());
        return {status:r.granted?"applied":r.uncertain?"unknown":"not-applied",verification:"attribute",before:r.before,after:r.after,
          message:r.granted?`道具数量 ${r.before} → ${r.after}`:r.reason??"发放未完成",handle:{item:id,before:r.before??-1,count}};},
      inspect_item:(receipt?:EffectEvidence):EffectEvidence=>{const h=receipt?.handle;if(!h)return unknown("缺少道具发货回执");
        const current=pouchCount(`native_item_${h.item}`);return {...receipt!,status:receipt?.status==="applied"?"applied":"unknown",message:`当前数量 ${current}；道具可能被使用、领取或转移，仅凭当前数量不能归因原订单，不补扣、不重放`};},
      check_gacha:(pool:number)=>this.gacha.hasPool(`gacha_${pool}`)?null:"该奖池未配置有效装备",
      roll_gacha:(pool:number):EffectEvidence=>{const r=this.gacha.roll(`gacha_${pool}`);return {status:r.ok?"applied":r.uncertain?"unknown":"not-applied",verification:"attribute",message:r.ok?`装备抽取：${r.name??r.id}`:r.reason??"抽取失败"};},
      inspect_gacha:(receipt?:EffectEvidence):EffectEvidence=>receipt?.status==="applied"?receipt:unknown("装备归属需核对原生发放记录，不重复抽取"),
    };
  }
  availablePt():number {return this.engine?.available(this.multiplayer?.self??"local")??this.session().core.state.wallet.pt;}
  runtimeGroupInUse(group:string):boolean{return (this.engine?.snapshot()??[]).some(o=>o.context.run===this.run&&o.offer.definition.group===group&&
    ["reserved","locked","applying","active","suspended","cleaning","uncertain","recovery"].includes(o.state));}
  blockingReason():string|null{
    const unresolved=this.engine?.snapshot().find(o=>o.context.run===this.run&&['failed','uncertain','recovery','cleaning'].includes(o.state));
    if(unresolved)return `效果订单待处理，不能开始下一波：${unresolved.message}；可核实订单或安全停止本局`;
    if(this.cleanupDue())return '上波效果仍在清理或核验，尚未允许下一波或新交易';
    if(this.peer?.diagnostic().closed)return this.peer.diagnostic().reason||'联机效果会话已关闭，请安全结束本局';
    if(this.peer&&!this.peer.diagnostic().ready)return '等待固定队员确认效果信箱；尚未允许新购买或开战';
    if(this.peer?.busy()&&!this.executingPermit)return '联机效果交易正在等待许可或交付核验，暂不能开始下一波';
    return null;
  }
  offers(): {offer:EffectOffer;description:string;canBuy:boolean;reason:string|null}[] {
    this.invalidProducts=[];
    const cfg=this.session().core.config.effectShop;if(!cfg)return [];
    let c:EffectContext|null=null,scopeReason="请先开始本局";try{c=this.scope();}catch(e){const text=String(e);scopeReason=text.startsWith("Error: ")?text.slice(7):text;}
    const entries:{offer:EffectOffer;description:string;canBuy:boolean;reason:string|null}[]=[];
    for(const p of cfg.products){try{const offer=this.catalog.offer(p,cfg.groups);const reason=c?this.engine!.check(offer,c):scopeReason;
      entries.push({offer,description:effectDescription(offer),canBuy:!reason,reason});
    }catch(e){this.invalidProducts.push({id:p.id,name:p.name,reason:String(e)});}}
    return entries;
  }
  validate(config:RogueConfig):void {
    if(!config.effectShop)return;
    if(!Array.isArray(config.effectShop.products)||config.effectShop.products.length>128)throw new Error("效果商品数量不能超过128");
    const ids:string[]=[];
    const issues:string[]=[];
    for(const product of config.effectShop.products){if(ids.includes(product.id)||config.shop.some(p=>p.id===product.id))throw new Error("效果商品ID重复");ids.push(product.id);
      try{this.catalog.offer(product,config.effectShop.groups);}catch(e){if(product.enabled)issues.push(`${product.name}：${String(e)}`);}}
    if(issues.length>0)throw new Error(`以下上架商品无法发布：${issues.join("；")}`);
  }
  command(sub:string,value:{itemId?:string;offerVersion?:string;orderId?:string;requestId:string}):unknown {
    if(sub==="reload"){if(!["Idle","Finished","Fault"].includes(this.session().stage))throw new Error("只能在局外刷新效果实现");this.catalog.load();return {ok:true,message:"效果目录已刷新"};}
    if(sub==="buy") {if((!this.engine||this.ended)&&this.session().startupStatus.prepared)this.start();const c=this.scope(),offer=this.offers().find(v=>v.offer.id===value.itemId)?.offer;if(!offer)throw new Error("效果商品不存在");
      if(this.peer){const reason=this.engine!.check(offer,c);if(reason)throw new Error(reason);this.peer.submit(value.requestId,'buy',offer.id,value.offerVersion??'');return {ok:true,pending:true,message:'等待房主冻结许可及本机预留／交付核验'};}
      return this.engine!.reserve(offer,value.offerVersion??"",c,value.requestId);}
    if(sub==="cancel"){if(!this.engine)throw new Error("没有本局订单");if(this.peer){this.peer.submit(value.requestId,'cancel',value.orderId??'');return {ok:true,pending:true,message:'等待房主与本机确认取消；名额仍保留'};}return this.engine.cancel(value.orderId??"","local");}
    if(sub==="dismiss"){const c=this.scope();if(!this.engine||!["Preparing","Selecting"].includes(c.phase))throw new Error("请在准备或整备阶段处理未交付订单");return this.engine.dismissFailure(value.orderId??"",c.player);}
    if(sub==="inspect"){if(!this.engine)throw new Error("没有本局订单");return this.engine.reconcile(value.orderId??"");}
    if(sub==="cleanup"){const s=this.session();if(!this.engine||(!["Idle","Finished","Fault","Carve","PreparingCombat"].includes(s.stage)&&!(s.stage==="Selecting"&&s.canShop())))throw new Error("请先安全结束波次或本局，再核验清理");return this.engine.cleanupOrder(value.orderId??"");}
    if(sub==="continue"){
      if(this.session().stage!=="PreparingCombat")throw new Error("当前没有受保护的开战准备");
      const unresolved=this.waveOrders().find(o=>["failed","uncertain","recovery","applying","cleaning","suspended"].includes(o.state));
      if(unresolved)throw new Error(`请先处理订单：${unresolved.message}`);
      return {ok:true,message:"订单允许重新检查准备；实际开战仍须通过原生核验"};
    }
    throw new Error("未知效果命令");
  }
  prepareWave():{ok:boolean;reason?:string} {
    if(!this.engine)return {ok:true};const blocking=this.blockingReason();if(blocking)return {ok:false,reason:blocking};
    if(this.peer){const locked=this.peer.lockWave();if(!locked.ok)return locked;const c=this.scope();this.engine.lockForNative(c.run,c.wave);return {ok:true};}
    // Configured-but-unused experimental products must not break the existing
    // multiplayer run. Only actual offline commitments require resolution.
    if(this.session().readingSnapshot?.online)return this.requiresNativePreparation()?{ok:false,reason:"仍有离线效果订单，不能带入联机波次；请先安全结束并恢复"}:{ok:true};
    const c=this.scope();
    if(!this.session().readingSnapshot?.quest?.playing){this.engine.lockForNative(c.run,c.wave);return {ok:true};}
    if(localPlayer()?.call("isDie")!==false||!data())return {ok:false,reason:"原生角色尚未就绪，尚未开始应用或出怪"};
    const result=this.engine.lockWave(c.run,c.wave);return {ok:result.ok,reason:result.message};
  }
  private waveOrders():EffectOrder[]{const wave=`${this.run}/wave-${this.session().core.state.layer}`;
    return this.engine?.snapshot().filter(o=>o.context.run===this.run&&o.context.wave===wave&&o.offer.definition.delivery==="nextWave")??[];}
  requiresNativePreparation():boolean{return this.peer!==null||this.waveOrders().some(o=>!["ended","cancelled","retired"].includes(o.state));}
  prepareNativeCombat(unique:number):{ok:boolean;pending?:boolean;reason?:string}{
    if(!this.engine)return {ok:true};
    if(this.cleanupDue()){
      const unresolved=this.engine.snapshot().find(o=>o.context.run===this.run&&o.context.layer<this.session().core.state.layer&&['uncertain','recovery','applying'].includes(o.state));
      return {ok:false,pending:!unresolved,reason:unresolved?.message??'等待上一波效果清理并核验'};
    }
    if(this.session().readingSnapshot?.online&&!this.peer)return {ok:false,reason:"原生联机效果准备尚未验收"};
    if(this.peer){const locked=this.peer.lockWave();if(!locked.ok)return {ok:false,pending:!this.peer.diagnostic().closed,reason:locked.reason};}
    if(localPlayer()?.call("isDie")!==false||!data())return {ok:false,pending:true,reason:"等待原生角色载入完成"};
    this.nativeQuestUniqueOverride=unique;
    try{
      const wave=`${this.run}/wave-${this.session().core.state.layer}`;
      const result=this.engine.lockWave(this.run,wave);if(!result.ok)return {ok:false,reason:result.message};
      this.monitorAttributes();
      const unresolved=this.waveOrders().find(o=>!["active","ended","cancelled","retired"].includes(o.state));
      if(unresolved)return {ok:false,reason:unresolved.message};
      if(this.peer){this.peer.nativePrepared();return this.peer.released()?{ok:true}:{ok:false,pending:true,reason:'本机效果已核验，等待全队实际准备确认'};}
      return {ok:true};
    }finally{this.nativeQuestUniqueOverride=null;}
  }
  tick():void {
    const now=clockSeconds();if(now===this.lastTick)return;this.lastTick=now;
    try {
      const s=this.session();
      if(s.startupStatus.prepared&&(!this.engine||this.ended)&&(this.config().effectShop?.products.length??0)>0&&!["Idle","Finished","Fault"].includes(s.stage))this.start();
      if(!this.engine)return;
      if(this.peer)enqueueEquipmentWork(this.peerWork,()=>this.peer?.tick(),reason=>this.peer?.close(reason));
      if(s.stage==="Combat"&&s.readingSnapshot?.quest?.playing)this.monitorAttributes();
      const lifecycle=`${this.run}|${s.stage}|${s.core.state.layer}`;if(lifecycle===this.lifecycle)return;this.lifecycle=lifecycle;
      if(s.stage==="Carve")this.engine.endWave(this.run,`${this.run}/wave-${s.core.state.layer}`);
      if(["Idle","Finished","Fault"].includes(s.stage)){this.engine.endRun(this.run);this.ended=true;}
      if(this.lastLayer!==s.core.state.layer&&this.lastLayer>0)this.engine.endWave(this.run,`${this.run}/wave-${this.lastLayer}`);
      this.lastLayer=s.core.state.layer;
    }catch(e){this.notice=String(e);}
  }
  private monitorAttributes():void {
    const active=this.engine!.snapshot().filter(o=>["active","suspended"].includes(o.state)&&o.offer.definition.delivery==="nextWave"&&typeof o.evidence?.handle?.field==="string");
    if(active.length===0)return;
    const player=localPlayer();
    let dying:unknown=null;try{dying=player?.call("isDie");}catch{ /* No physical effect can be certified while the actor is unavailable. */ }
    if(dying!==false||!data()){
      for(const order of active)this.engine!.suspend(order.id,"猫车或角色载入中，等待原生复活完成后恢复本波效果；已扣款，不重复扣款");
      return;
    }
    const fields:string[]=[];
    for(const order of active){const field=order.evidence?.handle?.field;if(typeof field==="string"&&!fields.includes(field))fields.push(field);}
    const context=this.nativeContext();
    for(const field of fields){
      const group=active.filter(o=>o.evidence?.handle?.field===field),last=group[group.length-1]!,h=last.evidence!.handle!;
      if(h.nativeContext===context&&!group.some(o=>o.state==="suspended")){
        if(this.stat(field)!==h.after)for(const o of group)this.engine!.invalidate(o.id,"属性被原生或其他系统改写，不能继续显示生效");
      }else{
        const observed=this.stat(field),address=data()!.get_address();
        const retained=observed===h.after&&group.every(o=>o.evidence?.handle?.dataAddress===address)?observed:undefined;
        let failed=false;
        for(const o of group){
          if(failed){this.engine!.invalidate(o.id,"同组重新绑定未完成");continue;}
          const result=this.engine!.rebind(o.id,retained);if(!result.ok){this.engine!.invalidate(o.id,result.message);failed=true;this.notice=result.message;}
        }
      }
    }
  }
  snapshot():unknown {
    try{const offers=this.offers();const active=this.session().core.config.effectShop??null,next=this.config().effectShop??null;
      return {definitions:this.catalog.list(),offers,invalidProducts:this.invalidProducts,orders:this.engine?.snapshot()??[],
      configuration:{applies:"nextRun",nextRunPending:canonical(active)!==canonical(next)},
      availablePt:this.availablePt(),reservedPt:this.engine?.reserved(this.multiplayer?.self??"local")??0,message:this.notice??this.blockingReason(),blockedReason:this.blockingReason(),run:this.run,
      multiplayer:this.peer?.diagnostic()??null};}
    catch(e){return {definitions:this.catalog.list(),offers:[],orders:this.engine?.snapshot()??[],message:String(e)};}
  }
  shutdown():void {cancelEquipmentWork(this.peerWork);this.peer?.close('脚本已重置，原许可不能重放');this.engine?.endRun(this.run);}
  afterInventoryRecovery(token:string):void {
    const proof=loadWebconsole().steam_digest?.(token);if(!proof||proof.length!==64)throw new Error("原生恢复证明摘要不可用，效果记录保留");
    const record=readRecoveryRecord<EffectJournal>(JOURNAL);
    if(!record?.active){this.retireNetwork(proof);return;}
    const current=assertRecoveryOwner(record.owner);
    if(record.schema!==1||!Array.isArray(record.orders))throw new Error("效果恢复记录格式未知，保留原件");
    const oldProcess=record.owner.process!==current.process;
    for(const o of record.orders){
      if(["ended","cancelled","failed","retired"].includes(o.state))continue;
      if(["reserved","locked"].includes(o.state)){o.state="cancelled";o.message="上局尚未应用，原资源恢复并保存后取消预订";continue;}
      // The prototype adapter can mutate only inventory and the two transient
      // player fields. Legacy frozen receipts identify those fields explicitly.
      const inventory=o.offer.definition.recoveryScope==="inventory"||["item.grant","equipment.roll"].includes(o.offer.definition.id);
      const attribute=o.offer.definition.recoveryScope==="runtimeAttribute"||
        ["_AtkUpAlive","_DefUpAlive"].includes(String(o.evidence?.handle?.field));
      const h=o.evidence?.handle,address=data()?.get_address();
      const replaced=typeof h?.dataAddress==="number"&&address!==undefined&&address!==h.dataAddress;
      let atGroupBaseline=false;
      if(attribute&&h&&address===h.dataAddress&&["_AtkUpAlive","_DefUpAlive"].includes(String(h.field))){
        // A confirmed native attempt may still be unpaid because delivery was
        // uncertain. Its original baseline remains relevant to restoration;
        // payment is not proof that the object was or was not modified.
        const first=record.orders.find(v=>v.context.wave===o.context.wave&&v.evidence?.handle?.field===h.field&&v.evidence?.handle?.dataAddress===h.dataAddress);
        const baseline=first?.evidence?.handle?.before;
        atGroupBaseline=typeof baseline==="number"&&this.stat(String(h.field))===baseline;
      }
      if(!inventory&&!(attribute&&(oldProcess||replaced||atGroupBaseline)))continue;
      const reason=inventory?"原物资及装备已精确恢复，并完成本角色原生保存":oldProcess?"原进程已结束，旧属性对象已销毁；原资源已恢复并保存":replaced?
        "原生属性对象已替换，原资源已恢复并完成保存":"实际属性已回到本波整组原始基线，原资源已恢复并完成保存";
      if(this.engine&&this.run===record.run)this.engine.retireRecovered(o.id,proof,reason);
      o.state="retired";o.retirement={proof,reason};o.message=`本局已恢复后封存：${reason}；交付历史保持原样，不补扣或重放`;
    }
    record.active=record.orders.some(o=>!["ended","cancelled","failed","retired"].includes(o.state));
    if(!writeRecoveryRecord(JOURNAL,record))throw new Error("效果订单封存失败，原记录保留");
    if(!record.active)this.retireNetwork(proof);
  }
  private retireNetwork(proof:string):void{
    const record=readRecoveryRecord<NetworkJournal>(NETWORK_JOURNAL);
    if(record?.active){assertRecoveryOwner(record.owner);if(record.schema!==1||record.network?.schema!==1)throw new Error('联机效果恢复记录格式未知，保留原件');
      if(this.peer)this.peer.retire(proof);
      else{record.active=false;record.network.closed=true;record.network.reason='本局原资源已恢复并完成原生保存，旧许可不重放';record.network.retirement=proof;
        if(!writeRecoveryRecord(NETWORK_JOURNAL,record))throw new Error('联机效果恢复封存失败');}}
    cancelEquipmentWork(this.peerWork);this.peer=null;this.multiplayer=null;
  }
}
