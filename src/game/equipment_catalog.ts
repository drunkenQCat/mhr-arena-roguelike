/** Read the installed game's equipment data before reserving or writing a box slot. */
import { findTypeDefinition, type REManagedObject } from "./sdk";
import type { RogueConfig } from "../core/config";
import { armorId } from "../core/equipment_id";

export function equipmentUnavailableReason(kind: "armor" | "weapon", id: number): string | null {
  if (!Number.isInteger(id) || id <= 0 || id > 0xffffffff) return "装备 ID 必须是有效的 32 位正整数";
  try {
    const type = findTypeDefinition("snow.data.DataShortcut");
    const parameter = kind === "armor" ? "snow.data.DataDef.PlArmorId" : "snow.data.ContentsIdSystem.WeaponId";
    const valid = type?.get_method(`isValid(${parameter})`);
    const lookup = type?.get_method(`${kind === "armor" ? "getArmorBaseData" : "getPlainWeaponData"}(${parameter})`);
    if (!valid || !lookup) return "原生装备目录校验接口不可用，未发放装备";
    if (valid.call(null, id) !== true)
      return `游戏不支持此${kind === "armor" ? "防具" : "武器"} ID：${id}`;
    const data = lookup.call(null, id) as REManagedObject | null;
    if (!data) return `游戏装备数据尚未就绪或此 ID 没有对应数据：${id}`;
    if (data.call("get_Id") !== id) return `装备目录返回了不同 ID，未发放：${id}`;
    return null;
  } catch (error) { return `原生装备目录读取失败，未发放装备：${String(error)}`; }
}

/** Validate all selectable startup sets and configured draws before saving a proposal. */
export function validateEquipmentConfig(config: RogueConfig): void {
  const check = (kind: "armor" | "weapon", id: number, path: string) => {
    const reason = equipmentUnavailableReason(kind, id);
    if (reason) throw new Error(`${path}：${reason}`);
  };
  for (const name of config.armorOptions) {
    const spec = config.armorSets?.[name];
    if (!spec) throw new Error(`armorSets.${name}：请先定义初始防具套装`);
    for (const part of [1,2,3,4,5] as const) check("armor", armorId(spec.series,part), `armorSets.${name}[${part}]`);
  }
  const rules = config.startupRules;
  if (rules && !rules.keepPlayerWeapon && rules.weaponId !== null) check("weapon", rules.weaponId, "startupRules.weaponId");
  for (const pool of Object.keys(config.gachaPools ?? {})) {
    const entries = config.gachaPools![pool]!.entries;
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!;
      check(entry.kind, entry.id, `gachaPools.${pool}.entries[${i}].id`);
    }
  }
}
