import { loadWebconsole, type REManagedArray, type REManagedObject } from "./sdk";
import { canonical } from "./wire_canonical";

// Serialized EquipmentInventoryData fields in the installed Rise TDB/RSZ.
// Sort caches, object addresses, paired-insect references and cheat caches are
// runtime state and deliberately excluded. Augments, decorations and colors are not.
const NUMBERS = ["_IdType", "_IdVal", "_BowgunCustomizeType", "_PairInsectInventoryIndex", "_HyakuryuModelId",
  "_BuildupPoint", "_CustomCount", "_CustomBuildupType", "_HyakuryuDecoId"];
const BOOLEANS = ["_IsSetGuildCard", "_IsLock", "_CustomEnable"];
const ARRAYS = ["_HyakuryuSkillIdList", "_PrevHyakuryuSkillId", "_TalismanDecoSlotNumList", "_TalismanSkillIdList",
  "_TalismanSkillLvList", "_CustomOpenIdArray", "_DecoIdList"];

function integer(o: REManagedObject, name: string): number {
  const n = o.get_field(name) as number;
  if (!Number.isInteger(n) || Math.abs(n) > 9007199254740991) throw new Error(`Equipment field unavailable: ${name}`);
  return n;
}
function boolean(o: REManagedObject, name: string): boolean {
  const value = o.get_field(name);
  if (typeof value !== "boolean") throw new Error(`Equipment flag unavailable: ${name}`);
  return value;
}
function array(value: unknown, read: (v: unknown) => unknown): unknown[] | null {
  if (value == null) return null;
  const a = value as REManagedArray, size = a.get_size();
  if (!Number.isInteger(size) || size < 0 || size > 256) throw new Error("Equipment array length invalid");
  const out: unknown[] = [];
  // get_element boxes primitive enums in this REFramework build; the typed
  // getter returns their numbers and also handles managed reference arrays.
  for (let i = 0; i < size; i++) out.push(read(a.call("get_Item",i)));
  return out;
}

export function equipmentFingerprint(e: REManagedObject): string {
  const data: Record<string, unknown> = { schema:"mhr-equipment-1" };
  for (const f of NUMBERS) data[f] = integer(e, f);
  for (const f of BOOLEANS) data[f] = boolean(e, f);
  for (const f of ARRAYS) data[f] = array(e.get_field(f), v => {
    if (typeof v !== "number" || !Number.isInteger(v) || Math.abs(v) > 9007199254740991) throw new Error(`Equipment array value invalid: ${f}`);
    return v;
  });
  data._CustomBuildup = array(e.get_field("_CustomBuildup"), v => {
    if (!v) return null;
    const o = v as REManagedObject;
    return [integer(o,"_Id"), integer(o,"_ValueIndex"), integer(o,"_SkillId")];
  });
  const color = e.get_field("_HyakuryuColorData") as REManagedObject | null;
  if (color) {
    const xyz = color.get_field("_Color") as REManagedObject;
    data._HyakuryuColorData = [boolean(color,"_IsEnable"), boolean(color,"_IsDefault"),
      integer(xyz,"x"), integer(xyz,"y"), integer(xyz,"z")];
  } else data._HyakuryuColorData = null;
  const hash = loadWebconsole().steam_digest?.(canonical(data));
  if (typeof hash !== "string" || hash.length !== 64) throw new Error("Equipment snapshot digest unavailable");
  return hash;
}

export interface EquipmentSnapshot { capacity: number; originalCount: number; entries: Record<string,string> }
export interface EquipmentReservation { boxIndex: number; idType: number; idVal: number; fingerprint?: string; acceptedFingerprints?: string[]; removed?: boolean }

function list(box: REManagedObject): REManagedObject {
  const items = box.get_field("_WeaponArmorInventoryList") as REManagedObject | null;
  if (!items) throw new Error("Equipment inventory unavailable");
  return items;
}
function size(items: REManagedObject): number {
  const n = items.call("get_Count") as number;
  if (!Number.isInteger(n) || n < 0 || n > 100000) throw new Error("Equipment inventory size invalid");
  return n;
}
export function captureEquipmentBox(box: REManagedObject): EquipmentSnapshot {
  const items = list(box), capacity = size(items), entries: Record<string,string> = {};
  for (let i = 0; i < capacity; i++) {
    const e = items.call("get_Item",i) as REManagedObject;
    if (!e || !Number.isInteger(e.get_field("_IdType"))) throw new Error("Equipment slot unreadable");
    if (e.get_field("_IdType") !== 0) entries[String(i)] = equipmentFingerprint(e);
  }
  return {capacity, originalCount:Object.keys(entries).length, entries};
}

export function validateEquipmentSnapshot(s: EquipmentSnapshot): void {
  if (!s || !Number.isInteger(s.capacity) || s.capacity < 0 || s.capacity > 100000 ||
      !Number.isInteger(s.originalCount) || s.originalCount < 0 || s.originalCount > s.capacity)
    throw new Error("Original equipment snapshot invalid");
  s.entries = s.entries ?? {}; // Native JSON encodes an empty Lua table as null.
  if (typeof s.entries !== "object" || Object.keys(s.entries).length !== s.originalCount ||
      Object.keys(s.entries).some(k => !Number.isInteger(Number(k)) || Number(k) < 0 || Number(k) >= s.capacity ||
        typeof s.entries[k] !== "string" || s.entries[k]!.length !== 64))
    throw new Error("Original equipment snapshot incomplete");
}

/** Across a restart, refuse any unaccounted change, not only a different item ID
 * in a reserved slot. This runs before restoring worn indices or removing items. */
export function verifyEquipmentBox(box: REManagedObject, original: EquipmentSnapshot, grants: EquipmentReservation[], previousSave = false): void {
  validateEquipmentSnapshot(original);
  const items = list(box);
  if (size(items) !== original.capacity) throw new Error("Equipment box capacity changed; recovery retained");
  const reserved: Record<string,EquipmentReservation> = {};
  for (const g of grants) {
    const key = String(g.boxIndex);
    if (reserved[key] || original.entries[key] !== undefined || g.boxIndex < 0 || g.boxIndex >= original.capacity)
      throw new Error("Equipment reservation conflicts with original inventory");
    reserved[key] = g;
  }
  for (let i = 0; i < original.capacity; i++) {
    const e = items.call("get_Item",i) as REManagedObject;
    if (!e) throw new Error("Equipment slot unavailable");
    const key = String(i), previous = original.entries[key], grant = reserved[key];
    if (previous !== undefined) {
      if (e.get_field("_IdType") === 0 || equipmentFingerprint(e) !== previous)
        throw new Error("Original equipment changed; automatic recovery refused");
    } else if (e.get_field("_IdType") !== 0) {
      if (!grant || grant.removed && !previousSave || !grant.fingerprint || e.get_field("_IdType") !== grant.idType ||
          e.get_field("_IdVal") !== grant.idVal || ![grant.fingerprint, ...(grant.acceptedFingerprints ?? [])].includes(equipmentFingerprint(e)))
        throw new Error("Unverified equipment occupies an originally empty slot; recovery retained");
    }
  }
}
