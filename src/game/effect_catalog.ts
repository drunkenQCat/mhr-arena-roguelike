import { copyEffectValue, validateEffectDefinition, validateEffectProduct, type EffectDefinition, type EffectOffer, type EffectProduct, type EffectGroup } from "../core/effect_contract";
import type { EffectEvidence } from "../core/effect_orders";
import { refFs, rejson, loadWebconsole, loadEffectChunk } from "./sdk";
import { canonical } from "./wire_canonical";

/** @noSelf */
export interface LuaEffectProgram {
  definition: EffectDefinition;
  check(api: object, parameters: Record<string, number>): string | null;
  apply(api: object, parameters: Record<string, number>): EffectEvidence;
  inspect(api: object, parameters: Record<string, number>, evidence?: EffectEvidence): EffectEvidence;
  remove(api: object, parameters: Record<string, number>, evidence?: EffectEvidence): EffectEvidence;
  rebind?(api: object, parameters: Record<string, number>, evidence?: EffectEvidence): EffectEvidence;
}

/** Immutable programs keyed by content, so a changed file cannot rewrite an accepted promise. */
export class EffectCatalog {
  private programs: Record<string, LuaEffectProgram> = {};
  private definitions: EffectDefinition[] = [];
  load(): void {
    const text = refFs.read("rogue_effect_catalog.json");
    if (!text) { this.definitions = []; return; }
    const manifest = rejson.load_string(text) as {schema:number;modules:string[]};
    if (manifest?.schema !== 1 || !Array.isArray(manifest.modules) || manifest.modules.length > 64) throw new Error("效果目录格式或数量非法");
    const next: EffectDefinition[] = [];
    for (const path of manifest.modules) {
      if (!path.startsWith("rogue_effects/") || path.includes("..") || !path.endsWith(".lua") ||
          path.split("").some(c => !"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_./-".includes(c))) throw new Error("效果脚本必须在 rogue_effects 下，使用 ASCII 相对路径");
      const source = refFs.read(path); if (!source || source.length > 65536) throw new Error(`效果脚本缺失或过大：${path}`);
      const hash = loadWebconsole().steam_digest?.(source); if (!hash || hash.length !== 64) throw new Error("效果脚本摘要不可用");
      const program = this.programs[hash] ?? loadEffectChunk(source,path) as LuaEffectProgram;
      if (!program?.definition || typeof program.apply !== "function" || typeof program.check !== "function" ||
          typeof program.inspect !== "function" || typeof program.remove !== "function") throw new Error(`效果接口不完整：${path}`);
      const d = program.definition; d.implementation = hash;
      if(d.rebindOnNativeReset===true&&(d.delivery!=="nextWave"||typeof program.rebind!=="function"))throw new Error(`声明重新绑定的效果必须是下一波效果且提供 rebind：${path}`);
      // Lua uses false for nullable fields, since nil would omit a key.
      if (!d.quantityParameter) d.quantityParameter = null;
      validateEffectDefinition(d);
      if (!d.id || !d.name || !d.version || !d.group || !["instant", "nextWave"].includes(d.delivery) ||
          !["registration", "attribute", "combat"].includes(d.verification) || next.some(v => v.id === d.id)) throw new Error(`效果定义非法或重复：${path}`);
      this.programs[hash] = program; next.push(copyEffectValue(d));
    }
    this.definitions = next;
  }
  list(): EffectDefinition[] { return copyEffectValue(this.definitions); }
  program(hash: string): LuaEffectProgram { const p = this.programs[hash]; if (!p) throw new Error("冻结的效果实现不可用；保留订单，禁止替换实现后执行"); return p; }
  offer(product: EffectProduct, groups: Record<string,EffectGroup>): EffectOffer {
    const definition = this.definitions.find(d => d.id === product.effect.id);
    if (!definition) throw new Error(`商品 ${product.name} 的效果已失效`);
    const group = groups[definition.group]; if (!group) throw new Error(`缺少效果组 ${definition.group}`);
    validateEffectProduct(product,definition,group);
    const frozen = copyEffectValue({...product, definition, groupRule:group});
    const revision = loadWebconsole().steam_digest?.(canonical(frozen)); if (!revision) throw new Error("商品版本摘要失败");
    return {...frozen,revision};
  }
}
