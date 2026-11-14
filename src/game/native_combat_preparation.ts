import type {QuestIdentity} from '../core/run_session';

export interface PreparationEnemy {
  uid:number;address:number;
  resolved(this:void):boolean;
  active(this:void):boolean;
  setActive(this:void,value:boolean):void;
}
interface PreparationPort {
  now():number;
  valid(identity:QuestIdentity):boolean;
  required():boolean;
  nativeReady():boolean;
  prepare(unique:number):{ok:boolean;pending?:boolean;reason?:string};
  enemies():PreparationEnemy[];
  report(event:string,detail:unknown):void;
}
type State='inactive'|'waiting'|'blocked'|'restoring'|'ready';

/** Objects may be constructed before the player exists. This gate permits
 * loading and player updates, but holds native enemy updates and player input
 * until the frozen orders have actually been applied and read back. */
export class NativeCombatPreparation {
  private identity:QuestIdentity|null=null;
  private token:number|null=null;
  private state:State='inactive';
  private held:{uid:number;address:number}[]=[];
  private nextCheck=0;
  private reason='';
  constructor(private readonly port:PreparationPort){}
  private valid():boolean {try{return !!this.identity&&this.port.valid(this.identity);}catch{return false;}}
  private transition(state:State,reason:string):void {
    if(this.state===state&&this.reason===reason)return;
    this.state=state;this.reason=reason;
    this.port.report('effect-combat-preparation',{state,reason,identity:this.identity,held:this.held.length});
  }
  begin(identity:QuestIdentity,token=0):void {
    if(this.identity?.id===identity.id&&this.identity.unique===identity.unique&&this.token===token&&this.state!=='inactive')return;
    this.end();if(!this.port.required()||!this.port.valid(identity))return;
    this.identity={...identity};this.token=token;this.nextCheck=0;
    this.transition('waiting','场地载入中；订单已锁定，等待原生角色就绪后应用和扣款');
  }
  blocksInput():boolean {return ['waiting','blocked','restoring'].includes(this.state)&&this.valid();}
  private blocked():boolean{return this.state==='blocked';}
  hold(enemy:PreparationEnemy):void {
    if(!['waiting','blocked'].includes(this.state)||!this.valid())return;
    try {
      // Previous inPlace waves can retain corpses in the native set list.
      // Pausing those actors interferes with their cleanup and is unrelated
      // to protecting the new battle while its effects are being prepared.
      if(enemy.resolved()||!enemy.active())return;
      if(!this.held.some(e=>e.uid===enemy.uid&&e.address===enemy.address))this.held.push({uid:enemy.uid,address:enemy.address});
      enemy.setActive(false);
      if(enemy.active())throw new Error('未能核验怪物更新暂停，不能开放战斗');
    }catch(e){this.transition('blocked',String(e));}
  }
  private restore():boolean {
    if(this.held.length===0)return true;
    if(!this.valid()){this.held=[];return true;}
    const enemies=this.port.enemies();let complete=true;
    for(const ticket of [...this.held]){
      const enemy=enemies.find(e=>e.uid===ticket.uid&&e.address===ticket.address);
      if(!enemy){complete=false;continue;}
      if(!enemy.active())enemy.setActive(true);
      if(!enemy.active()){complete=false;continue;}
      this.held=this.held.filter(e=>e.uid!==ticket.uid||e.address!==ticket.address);
    }
    return complete;
  }
  tick():void {
    if(!['waiting','blocked'].includes(this.state))return;
    if(!this.valid()){this.end();return;}
    if(this.state==='blocked'||this.port.now()<this.nextCheck)return;
    this.nextCheck=this.port.now()+1;
    try {
      for(const enemy of this.port.enemies())this.hold(enemy);
      if(this.blocked())return;
      if(!this.port.nativeReady())return;
      const result=this.port.prepare(this.identity!.unique);
      if(result.pending)return;
      if(!result.ok){this.transition('blocked',result.reason??'效果未通过核验；请处理订单或安全停止本局');return;}
      this.transition('restoring','效果已核验，正在恢复原生怪物更新');
      if(!this.restore()){this.transition('blocked','效果已核验，但怪物更新恢复尚未核实；请安全停止本局');return;}
      this.transition('ready','效果已实际核验，已恢复怪物更新并开放战斗');
    }catch(e){this.transition('blocked',String(e));}
  }
  retry():boolean {
    if(this.state!=='blocked'||!this.valid())return false;
    this.nextCheck=0;this.transition('waiting','已请求重新检查准备；未核验之前保持暂停');return true;
  }
  end():void {
    // Release our predicate before native setters run, so their post hooks
    // cannot re-acquire the exact update flags being restored.
    const old=this.state;this.state='inactive';
    try {if(!this.restore())this.port.report('effect-preparation-restore-pending',{identity:this.identity,held:this.held});}
    catch(e){this.port.report('effect-preparation-restore-pending',String(e));}
    this.held=[];this.identity=null;this.token=null;this.reason='';
    if(old!=='inactive')this.port.report('effect-combat-preparation',{state:'inactive'});
  }
  snapshot(){return {state:this.state,pending:this.blocksInput(),reason:this.reason,held:this.held.length,token:this.token,identity:this.identity?{...this.identity}:null};}
}
