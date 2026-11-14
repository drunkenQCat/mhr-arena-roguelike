/** Designer-visible effect contracts. This file has no game or browser globals. */
const safeInteger = (n: number) => Number.isInteger(n) && Math.abs(n) <= 9007199254740991;

export type Verification = "registration" | "attribute" | "combat";
export type Delivery = "instant" | "nextWave";
export type EffectPhase = "Preparing" | "Selecting" | "Carve" | "Combat";
export interface NumberParameter {
  name: string; description: string; unit: string; min: number; max: number; default: number; integer?: boolean;
}
export interface EffectDefinition {
  id: string; version: string; name: string; description: string;
  /** SHA256 of the exact implementation, provided by the loader. */
  implementation: string;
  delivery: Delivery; verification: Verification; experimental: boolean;
  /** Only explicitly repeatable, temporary attribute effects may rebind to a new native actor. */
  rebindOnNativeReset?: boolean;
  recoveryScope?: "inventory" | "runtimeAttribute";
  supportedPhases?: EffectPhase[];
  group: string; quantityParameter: string | null;
  parameters: Record<string, NumberParameter>;
}
export interface EffectBinding { id: string; version: string; parameters: Record<string, number> }
export interface EffectGroup { policy: "add" | "replace" | "unique"; cap: number }
export interface EffectConditions {
  phases: EffectPhase[]; fromLayer: number; toLayer: number;
  weapons: number[]; exclusiveGroups: string[];
  limit?: { count: number; scope: "playerWave" | "playerRun" | "teamWave" | "teamRun" };
}
export interface EffectProduct {
  id: string; name: string; price: number; enabled: boolean;
  effect: EffectBinding; conditions: EffectConditions;
}
export interface EffectOffer extends EffectProduct { definition: EffectDefinition; groupRule: EffectGroup; revision: string }

export function copyEffectValue<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(copyEffectValue) as T;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value)) result[key] = copyEffectValue((value as Record<string, unknown>)[key]);
  return result as T;
}

export function validateEffectDefinition(d:EffectDefinition):void {
  if(!d||typeof d!=="object"||[d.id,d.version,d.name,d.description,d.group].some(v=>typeof v!=="string"||v.trim().length===0)||
    !["instant","nextWave"].includes(d.delivery)||!["registration","attribute","combat"].includes(d.verification)||typeof d.experimental!=="boolean")
    throw new Error("效果定义缺少名称、版本、交付方式或验证声明");
  if(!d.parameters||typeof d.parameters!=="object"||Array.isArray(d.parameters)&&Object.keys(d.parameters).length>0||Object.keys(d.parameters).length>32)throw new Error("效果参数定义非法");
  for(const key of Object.keys(d.parameters)){
    const p=d.parameters[key];
    if(!p||typeof p!=="object"||[p.name,p.description,p.unit].some(v=>typeof v!=="string"||v.trim().length===0)||
      [p.min,p.max,p.default].some(n=>typeof n!=="number"||!Number.isFinite(n))||p.max<p.min||p.default<p.min||p.default>p.max||
      p.integer!==undefined&&typeof p.integer!=="boolean"||p.integer&&!safeInteger(p.default))throw new Error(`参数 ${key} 的单位、范围或默认值非法`);
  }
  if(d.quantityParameter!==null&&(typeof d.quantityParameter!=="string"||!d.parameters[d.quantityParameter]))throw new Error("效果量参数不存在");
  if(d.recoveryScope!==undefined&&!["inventory","runtimeAttribute"].includes(d.recoveryScope))throw new Error("效果恢复范围非法");
  if(d.delivery==="nextWave"&&d.recoveryScope==="inventory")throw new Error("物资与装备必须立即交付，不能作为延迟属性预订");
  if(d.rebindOnNativeReset!==undefined&&typeof d.rebindOnNativeReset!=="boolean")throw new Error("效果重绑定声明非法");
  if(d.rebindOnNativeReset===true&&(d.delivery!=="nextWave"||d.recoveryScope!=="runtimeAttribute"))throw new Error("只有下一波临时属性支持原生重绑定");
  if(d.supportedPhases!==undefined&&(!Array.isArray(d.supportedPhases)||d.supportedPhases.length===0||
    d.supportedPhases.some(p=>!["Preparing","Selecting","Carve","Combat"].includes(p))))throw new Error("效果支持的购买阶段非法");
}

export function validateEffectProduct(product: EffectProduct, definition: EffectDefinition, group: EffectGroup): void {
  if (!product.id || !product.name || !safeInteger(product.price) || product.price < 0 || typeof product.enabled !== "boolean")
    throw new Error("商品名称、标识、价格或上架状态非法");
  if (product.effect.id !== definition.id || product.effect.version !== definition.version || !definition.implementation)
    throw new Error("效果不存在或实现版本不匹配");
  if (definition.experimental) throw new Error("实验效果不能作为正式付费商品发布");
  for (const key of Object.keys(product.effect.parameters)) if (!definition.parameters[key]) throw new Error(`效果不支持参数 ${key}`);
  for (const key of Object.keys(definition.parameters)) {
    const p = definition.parameters[key]!, value = product.effect.parameters[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < p.min || value > p.max || p.integer && !safeInteger(value))
      throw new Error(`${p.name}应为 ${p.min}–${p.max} ${p.unit}${p.integer ? "，且为整数" : ""}`);
  }
  if (!["add", "replace", "unique"].includes(group.policy) || !Number.isFinite(group.cap) || group.cap <= 0)
    throw new Error("效果组上限或叠加方式非法");
  const amount = definition.quantityParameter ? product.effect.parameters[definition.quantityParameter] : 1;
  if (typeof amount !== "number" || amount <= 0 || amount > group.cap) throw new Error("商品效果量必须为正且不能超过效果组上限");
  const c = product.conditions;
  if (!Array.isArray(c.phases) || c.phases.length === 0 || c.phases.some(p => !["Preparing", "Selecting", "Carve", "Combat"].includes(p)))
    throw new Error("请至少选择一个支持的购买阶段");
  if(c.phases.some(p=>!(definition.supportedPhases??["Preparing","Selecting"]).includes(p)))throw new Error("所选阶段不在该效果的原生支持范围内");
  if (definition.delivery === "nextWave" && c.phases.some(p => p !== "Preparing" && p !== "Selecting"))
    throw new Error("下一波效果只支持开局准备和波间整备购买");
  if (!safeInteger(c.fromLayer) || !safeInteger(c.toLayer) || c.fromLayer < 1 || c.toLayer < c.fromLayer)
    throw new Error("商品开放层段非法");
  if (!Array.isArray(c.weapons) || c.weapons.some(w => !safeInteger(w) || w < 0 || w > 13) ||
      !Array.isArray(c.exclusiveGroups) || c.exclusiveGroups.includes(definition.group)) throw new Error("武器条件或互斥效果组非法");
  if (c.limit && (!safeInteger(c.limit.count) || c.limit.count < 0 ||
      !["playerWave", "playerRun", "teamWave", "teamRun"].includes(c.limit.scope))) throw new Error("限购规则非法");
}

export function effectDescription(offer: EffectOffer, parameterText?:Record<string,string>): string {
  const d = offer.definition;
  const values = Object.keys(d.parameters).map(k => parameterText?.[k]??`${d.parameters[k]!.name} ${offer.effect.parameters[k]} ${d.parameters[k]!.unit}`).join("；");
  const duration = d.delivery === "nextWave" ? "下一完整波次（含顺序双怪）；猫车保留，清波移除" : "立即交付";
  const policy = offer.groupRule.policy === "add" ? "叠加" : offer.groupRule.policy === "replace" ? "升级须先取消旧预订，已生效不可替换" : "不可重复";
  return `${d.name}：${values}。${duration}；购买者受益；${policy}，组上限 ${offer.groupRule.cap}。`;
}
