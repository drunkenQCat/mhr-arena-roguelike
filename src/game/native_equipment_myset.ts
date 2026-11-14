import { canonical } from "./wire_canonical";
import { callNativeFunction, createInstance, createManagedString, findTypeDefinition, getSingleton, type REManagedArray, type REManagedObject } from "./sdk";
import { requireEquipmentUpdate, retainEquipmentObject } from "./equipment_update";

const SET = "snow.equip.PlEquipMySetData";
const PACK = "snow.equip.PlEquipPack";
const MANAGER = "snow.data.EquipDataManager";
const actions = ["_ActionIdList", "_ActionIdListMR_Red", "_ActionIdListMR_Blue"] as const;
const scalars = ["IdVal", "InsectIdVal", "InsectInventoryIndex", "BowgunCustomizeType", "HyakuryuDecoId"] as const;
interface Color { enabled: boolean; default: boolean; x: number; y: number; z: number }
interface Backup { IdVal: number; InsectIdVal: number; InsectInventoryIndex: number;
  BowgunCustomizeType: number; HyakuryuDecoId: number; deco: number[]; color: Color; pigments: Color[] }
export interface EquipmentMySet {
  indices: number[]; using: boolean; name: string | false;
  _ActionIdList: number[]; _ActionIdListMR_Red: number[]; _ActionIdListMR_Blue: number[];
  backup: Backup[];
}
function native(object: REManagedObject, type: string, method: string, ...args: unknown[]): unknown {
  const td = findTypeDefinition(type);
  if (!td?.get_method(method)) throw new Error(`原生个人组合接口不可用：${method}`);
  return callNativeFunction(object, td, method, ...args);
}
function field(object: REManagedObject, name: string): REManagedObject {
  const value = object.get_field(name) as REManagedObject | null;
  if (!value) throw new Error(`个人组合字段缺失：${name}`);
  return value;
}
function array<T>(object: REManagedObject, read: (v: unknown) => T): T[] {
  const n = (object as REManagedArray).get_size();
  if (!Number.isInteger(n) || n < 0 || n > 32) throw new Error("个人组合数组长度无效");
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(read(object.call("get_Item", i)));
  return out;
}
function color(object: REManagedObject): Color {
  const c = field(object, "_Color");
  return { enabled: object.get_field("_IsEnable") as boolean, default: object.get_field("_IsDefault") as boolean,
    x: c.get_field("x") as number, y: c.get_field("y") as number, z: c.get_field("z") as number };
}
function numbers(object: REManagedObject, key: string): number[] { return array(field(object, key), v => v as number); }
function ints(v: unknown, length: number, min = 0): v is number[] {
  return Array.isArray(v) && v.length === length && v.every(n => Number.isInteger(n) && n >= min && n <= 0x7fffffff);
}
function validColor(c: Color): boolean {
  return !!c && typeof c.enabled === "boolean" && typeof c.default === "boolean" &&
    [c.x, c.y, c.z].every(n => Number.isInteger(n) && n >= -0x80000000 && n <= 0x7fffffff);
}
export function validateEquipmentMySet(v: EquipmentMySet): void {
  if (!v || !ints(v.indices, 8, -1) || typeof v.using !== "boolean" ||
      !(v.name === false || typeof v.name === "string" && v.name.length <= 256) ||
      !ints(v._ActionIdList, 3) || !ints(v._ActionIdListMR_Red, 5) || !ints(v._ActionIdListMR_Blue, 5) ||
      !Array.isArray(v.backup) || v.backup.length !== 8 || v.backup.some(b => !b ||
        scalars.some(k => !Number.isInteger(b[k]) || b[k] < -1 || b[k] > 0x7fffffff) || !ints(b.deco, 3) ||
        !validColor(b.color) || !Array.isArray(b.pigments) || b.pigments.length !== 2 || b.pigments.some(c => !validColor(c))))
    throw new Error("装备个人组合恢复记录无效，保留备份");
}
function serialize(object: REManagedObject): EquipmentMySet {
  const v: EquipmentMySet = {
    indices: numbers(object, "_InventoryIndexList"), using: object.get_field("_IsUsing") as boolean,
    name: (object.call("get_Name") ?? false) as string | false,
    _ActionIdList: numbers(object, actions[0]), _ActionIdListMR_Red: numbers(object, actions[1]),
    _ActionIdListMR_Blue: numbers(object, actions[2]),
    backup: array(field(object, "_BackupDataList"), value => {
      const b = value as REManagedObject;
      return { IdVal: b.get_field("IdVal") as number, InsectIdVal: b.get_field("InsectIdVal") as number,
        InsectInventoryIndex: b.get_field("InsectInventoryIndex") as number,
        BowgunCustomizeType: b.get_field("BowgunCustomizeType") as number, HyakuryuDecoId: b.get_field("HyakuryuDecoId") as number,
        deco: numbers(b, "DecoIdList"), color: color(field(b, "HyakuryuColorData")),
        pigments: array(field(field(b, "SymbolColorSet"), "_ColorData"), c => color(c as REManagedObject)) };
    })
  };
  validateEquipmentMySet(v); return v;
}
function fresh(): REManagedObject {
  requireEquipmentUpdate();
  const object = createInstance(SET);
  if (!object) throw new Error("无法创建独立装备个人组合");
  retainEquipmentObject(object);
  native(object, SET, ".ctor"); return object;
}
/** Independent object: never overwrites one of the player's saved loadout slots. */
export function captureEquipmentMySet(manager: REManagedObject): EquipmentMySet {
  const object = fresh();
  native(manager, MANAGER, "registerEquipMySet(snow.equip.PlEquipMySetData)", object);
  const snapshot = serialize(object);
  verifyReferences(manager.call("get_PlEquipPack") as REManagedObject, snapshot.indices, object);
  return snapshot;
}
function put(object: REManagedObject, values: number[]): void {
  if ((object as REManagedArray).get_size() !== values.length) throw new Error("个人组合数组容量变化");
  values.forEach((v, i) => object.call("set_Item", i, v));
}
function putColor(object: REManagedObject, v: Color): void {
  object.set_field("_IsEnable", v.enabled); object.set_field("_IsDefault", v.default);
  const c = field(object, "_Color"); c.set_field("x", v.x); c.set_field("y", v.y); c.set_field("z", v.z);
}
function preflightIndices(indices: number[], backup?: Backup[]): REManagedObject[] {
  const box = getSingleton("snow.data.DataManager")?.get_field("_PlEquipBox") as REManagedObject | null;
  if (!box) throw new Error("装备箱不可用");
  const refs: REManagedObject[] = [];
  for (let i = 0; i < 8; i++) {
    const index = indices[i]!;
    if (index < 0) continue;
    const list = field(box, i === 6 ? "_LvBuffCageInventoryList" : "_WeaponArmorInventoryList");
    const count = list.call("get_Count") as number;
    if (!Number.isInteger(count) || index >= count) throw new Error(`装备索引越界：${i}`);
    const entry = list.call("get_Item", index) as REManagedObject | null;
    if (!entry || entry.get_field("_IdType") === 0 || backup && entry.get_field("_IdVal") !== backup[i]!.IdVal)
      throw new Error(`原装备条目已变化：${i}`);
    refs[i] = entry;
  }
  return refs;
}
function contents(x: EquipmentMySet) {
  return {indices:x.indices, backup:x.backup, red:x._ActionIdListMR_Red, blue:x._ActionIdListMR_Blue, actions:x._ActionIdList};
}
export function equipmentMySetMatches(manager: REManagedObject, v: EquipmentMySet): boolean {
  validateEquipmentMySet(v);
  return canonical(contents(captureEquipmentMySet(manager))) === canonical(contents(v));
}
export function applyEquipmentMySet(manager: REManagedObject, v: EquipmentMySet): void {
  requireEquipmentUpdate(); validateEquipmentMySet(v);
  preflightIndices(v.indices, v.backup);
  // Fresh native object on every application; reusing a deserialized one failed live.
  const object = fresh(); native(object, SET, "initParam");
  object.set_field("_IsUsing", v.using);
  if (v.name !== false) native(object, SET, "setName", createManagedString(v.name));
  put(field(object, "_InventoryIndexList"), v.indices);
  for (const key of actions) put(field(object, key), v[key]);
  const list = field(object, "_BackupDataList");
  v.backup.forEach((b, i) => {
    const dest = list.call("get_Item", i) as REManagedObject;
    for (const key of scalars) dest.set_field(key, b[key]);
    put(field(dest, "DecoIdList"), b.deco); putColor(field(dest, "HyakuryuColorData"), b.color);
    const colors = field(field(dest, "SymbolColorSet"), "_ColorData");
    b.pigments.forEach((c, j) => putColor(colors.call("get_Item", j) as REManagedObject, c));
  });
  native(object, SET, "restoreVariableToRef");
  verifyReferences(object, v.indices);
  const resolved = field(object, "<InventoryDataList>k__BackingField");
  for (let i = 0; i < 8; i++) {
    const item = resolved.call("get_Item", i) as REManagedObject | null;
    if (item && item.get_field("_IdVal") !== v.backup[i]!.IdVal) throw new Error(`原装备条目已变化：${i}`);
  }
  if (native(manager, MANAGER, "applyEquipMySet(snow.equip.PlEquipMySetData)", object) !== true)
    throw new Error("原生装备个人组合应用失败");
  verifyReferences(manager.call("get_PlEquipPack") as REManagedObject, v.indices, object);
  const actual = captureEquipmentMySet(manager);
  // Preset names/usage flags belong to the independent container, not the worn kit.
  if (canonical(contents(actual)) !== canonical(contents(v))) throw new Error("装备个人组合内容读回不一致，恢复记录保留");
}
/** Resolves all eight categories natively, including the separate petalace box. */
export function applyEquipmentIndices(manager: REManagedObject, indices: number[]): void {
  requireEquipmentUpdate();
  if (!ints(indices, 8, -1)) throw new Error("装备索引无效");
  const expected = preflightIndices(indices);
  // applyEquipPack is a change request: resolve a detached desired pack before
  // letting the native manager update its live references and player requests.
  const pack = createInstance(PACK);
  if(!pack)throw new Error('无法创建原生装备切换请求');
  retainEquipmentObject(pack);native(pack,PACK,'.ctor');
  put(field(pack, "_InventoryIndexList"), indices);
  native(pack, PACK, "restoreVariableToRef");
  verifyReferences(pack, indices);
  const refs = field(pack, "<InventoryDataList>k__BackingField");
  for (let i = 0; i < 8; i++) {
    const actual = refs.call("get_Item", i) as REManagedObject | null;
    if (actual?.get_address() !== expected[i]?.get_address()) throw new Error(`装备实例不一致：${i}`);
  }
  native(pack, PACK, "applyEquipPack");
  const live=manager.call('get_PlEquipPack') as REManagedObject;
  native(live,PACK,'convertRefToVariable');
  verifyReferences(live, indices);
}
export function verifyReferences(pack: REManagedObject, indices: number[], expected?: REManagedObject): void {
  if (!pack || !ints(indices, 8, -1)) throw new Error("装备引用不可读");
  const live = field(pack, "<InventoryDataList>k__BackingField"), a = field(pack, "_InventoryIndexList");
  const want = expected ? field(expected, "<InventoryDataList>k__BackingField") : null;
  for (let i = 0; i < 8; i++) {
    const entry = live.call("get_Item", i) as REManagedObject | null;
    if (a.call("get_Item", i) !== indices[i] || (indices[i] === -1 ? !!entry : !entry || entry.get_field("_IdType") === 0))
      throw new Error(`装备索引与实际引用不一致：${i}`);
    if (want) {
      const original = want.call("get_Item", i) as REManagedObject | null;
      if (entry?.get_address() !== original?.get_address()) throw new Error(`装备实例不一致：${i}`);
    }
  }
}
