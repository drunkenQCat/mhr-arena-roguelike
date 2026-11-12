/** Native personal loadouts restore equipment references, decorations, pigments and
 * switch-skill selections. Durable owner-bound journals still own recovery and
 * temporary-item cleanup; no user preset slot or forced save is used. */

import { applyEquipmentIndices, applyEquipmentMySet, captureEquipmentMySet, equipmentMySetMatches, validateEquipmentMySet, verifyReferences, type EquipmentMySet } from "./native_equipment_myset";
import { getSingleton, relog, createInstance, callNativeFunction, findTypeDefinition, clockSeconds, type REManagedObject, type RETypeDefinition } from "./sdk";
import { requireEquipmentUpdate, retainEquipmentObject } from "./equipment_update";
import type { StartupRules } from "../core/config";
import { validArmorId, armorId } from "../core/equipment_id";
export { armorId } from "../core/equipment_id";
import { runJewelName, runJewelLevel } from "./run_jewel_catalog";
export { runJewelName } from "./run_jewel_catalog";
import { equipmentUnavailableReason } from "./equipment_catalog";
import { readRecoveryRecord, recoveryPending, writeRecoveryRecord, recoveryWriteFailure } from "./recovery_journal";
import { assertRecoveryOwner, readRecoveryOwner, type RecoveryOwner } from "./recovery_owner";
import { captureEquipmentBox, equipmentFingerprint, validateEquipmentSnapshot, verifyEquipmentBox, type EquipmentSnapshot } from "./equipment_snapshot";

/** pack 槽位（0 基）。 */
export const PACK_WEAPON = 0;
export const PACK_HEAD = 1;
export const PACK_CHEST = 2;
export const PACK_ARM = 3;
export const PACK_WAIST = 4;
export const PACK_LEG = 5;
export const PACK_INSECT = 6;
export const PACK_TALISMAN = 7;
export const PACK_LEN = 8;

function dataManager(): REManagedObject | null {
  return getSingleton("snow.data.DataManager");
}

function equipDataManager(): REManagedObject | null {
  return getSingleton("snow.data.EquipDataManager");
}

function equipmentBox(dm: REManagedObject | null): REManagedObject | null {
  if (!dm) return null;
  try {
    return (dm.get_field("_PlEquipBox") as REManagedObject | null) ??
      (dm.call("getEquipBox") as REManagedObject | null);
  } catch {
    return null;
  }
}

function weaponArmorList(box: REManagedObject | null): REManagedObject | null {
  if (!box) return null;
  return box.get_field("_WeaponArmorInventoryList") as REManagedObject | null;
}

const ADD_ARMOR_SPELLS = [
  "tryAddGameItem(snow.data.DataDef.PlArmorId, snow.data.EquipmentInventoryData)",
  "tryAddGameItem(snow.data.DataDef.PlArmorId,snow.data.EquipmentInventoryData)",
];
const ADD_WEAPON_SPELL = "tryAddGameItem(snow.data.ContentsIdSystem.WeaponId, snow.data.EquipmentInventoryData, System.Boolean)";

/** 命中第一个可用的显式重载名；全 miss 返回 null。 */
function findOverload(td: RETypeDefinition, spells: string[]): string | null {
  for (const spell of spells) {
    try {
      if (td.get_method(spell)) return spell;
    } catch { /* 命名不合法就换下一个拼写 */ }
  }
  return null;
}

/** 读权威 pack。失败返回 null（调用方不得假装成功）。 */
export function readPack(edm: REManagedObject | null): number[] | null {
  if (!edm) return null;
  try {
    const pack = edm.call("get_PlEquipPack") as REManagedObject | null;
    const arr = pack ? (pack.get_field("_InventoryIndexList") as REManagedObject | null) : null;
    if (!arr) return null;
    const count = arr.call("get_Count") as number;
    if (!Number.isInteger(count) || count < PACK_LEN) return null;
    const out: number[] = [];
    for (let i = 0; i < PACK_LEN; i++) {
      const v = arr.call("get_Item", i) as number;
      if (typeof v !== "number") return null;
      out.push(v);
    }
    return out;
  } catch {
    return null;
  }
}

/** Legacy single-slot entry: resolve references and apply through the native pack. */
export function writePackSlot(edm: REManagedObject | null, pos: number, boxIndex: number): boolean {
  const indices = readPack(edm);
  if (!edm || !indices || !Number.isInteger(pos) || pos < 0 || pos >= PACK_LEN) return false;
  try { indices[pos] = boxIndex; applyEquipmentIndices(edm, indices); return true; }
  catch { return false; }
}

/** 扫装备箱找 idVal 对应条目的箱内索引；找不到返回 null。 */
export function findEquipEntry(box: REManagedObject | null, idVal: number, idType: number): number | null {
  const list = weaponArmorList(box);
  if (!list) return null;
  try {
    const count = list.call("get_Count") as number;
    if (!Number.isInteger(count) || count < 0 || count > 100000) return null;
    for (let i = 0; i < count; i++) {
      const entry = list.call("get_Item", i) as REManagedObject | null;
      if (!entry) continue;
      if ((entry.get_field("_IdVal") as number) === idVal &&
        (entry.get_field("_IdType") as number) === idType) return i;
    }
  } catch { /* 箱不可读视同没找到 */ }
  return null;
}

function boxEntry(box: REManagedObject | null, index: number): REManagedObject | null {
  const list = weaponArmorList(box);
  if (!list) return null;
  try {
    return list.call("get_Item", index) as REManagedObject | null;
  } catch {
    return null;
  }
}

export interface GrantReport {
  ok: boolean;
  uncertain?: boolean;
  boxIndex?: number;
  reused?: boolean;
  reason?: string;
}

/**
 * 往装备箱发放一件装备（武器/防具）。读回 _IdType/_IdVal + 空槽数减一才算交付；
 * 部分写入标 uncertain，绝不自动重试。
 */
export function grantEquip(box: REManagedObject | null, idVal: number, kind: "armor" | "weapon",
  beforeGrant?: (entry: GrantedEntry) => boolean, reuseExisting = true,
  afterGrant?: (entry: GrantedEntry) => boolean): GrantReport {
  if (kind === "armor" && !validArmorId(idVal)) return {ok:false,reason:"Invalid armor ID: expected part 1–5"};
  const unavailable = equipmentUnavailableReason(kind, idVal);
  if (unavailable) return {ok:false,reason:unavailable};
  if (!box) return { ok: false, reason: "EquipBox unavailable" };
  const expectType = kind === "armor" ? 2 : 1;
  const existing = reuseExisting ? findEquipEntry(box, idVal, expectType) : null;
  if (existing !== null) return { ok: true, reused: true, boxIndex: existing };
  let slot: REManagedObject | null = null;
  try {
    const candidate = box.call("getEmptyWeaponArmorInventoryFirst") as REManagedObject | null;
    slot = candidate && (candidate.get_field("_IdType") as number) === 0 ? candidate : null;
  } catch { /* 槽接口失败按无空槽 */ }
  if (!slot) return { ok: false, reason: "装备箱无空槽" };
  let before = -1;
  try {
    before = box.call("countWeaponArmorEmptyNum") as number;
  } catch { /* 只影响辅助核验 */ }
  let spell: string | null = null;
  try {
    spell = findOverload(box.get_type_definition(),
      kind === "armor" ? ADD_ARMOR_SPELLS : [ADD_WEAPON_SPELL]);
  } catch {
    return { ok: false, reason: "EquipBox 类型不可读" };
  }
  if (!spell) return { ok: false, reason: `tryAddGameItem ${kind} 显式重载不存在` };
  const list = weaponArmorList(box);
  let reservedIndex = -1;
  if (list) for (let i = 0; i < (list.call("get_Count") as number); i++) {
    const candidate = boxEntry(box, i);
    if (candidate && (candidate === slot || (identity(candidate) !== undefined && identity(candidate) === identity(slot)))) {
      reservedIndex = i; break;
    }
    // Test facades lack addresses; production objects always expose get_address.
    if (identity(slot) === undefined && candidate?.get_field("_IdType") === 0) { reservedIndex = i; break; }
  }
  if (reservedIndex < 0) return { ok: false, reason: "Cannot identify empty equipment slot" };
  const reservation: GrantedEntry = { boxIndex: reservedIndex, idVal, idType: expectType, identity: identity(slot) };
  if (beforeGrant && !beforeGrant(reservation)) {
    return { ok: false, reason: "Equipment recovery journal could not be saved" };
  }
  try {
    if (kind === "armor") box.call(spell, idVal, slot);
    else box.call(spell, idVal, slot, false);
  } catch (error) {
    relog.error(`[MhwRogue] grantEquip 原生调用抛出（写入仍可能发生）: ${String(error)}`);
  }
  // 抛错≠未写入：读回裁决
  let idType: number, gotId: number, boxIndex: number | null;
  try {
    idType = slot.get_field("_IdType") as number;
    gotId = slot.get_field("_IdVal") as number;
    const written = boxEntry(box, reservedIndex);
    boxIndex = written?.get_field("_IdType") === expectType && written.get_field("_IdVal") === idVal ? reservedIndex : null;
  } catch { return {ok:false,uncertain:true,reason:"发放后装备身份不可读，禁止自动重试"}; }
  let after = -1;
  try {
    after = box.call("countWeaponArmorEmptyNum") as number;
  } catch { /* 同上 */ }
  if (idType === expectType && gotId === idVal && boxIndex !== null) {
    if (afterGrant) {
      try {
        reservation.fingerprint = equipmentFingerprint(slot);
        if (!afterGrant(reservation)) throw new Error("Cannot persist delivered equipment fingerprint");
      } catch (error) {
        return {ok:false, uncertain:true, boxIndex, reason:`装备已发放，持久身份尚未确认：${String(error)}；禁止重发`};
      }
    }
    const slotCountOk = before < 0 || after === before - 1;
    return {
      ok: true, uncertain: false, boxIndex,
      ...(slotCountOk ? {} : { reason: "空槽数读回不一致（条目已写入）" }),
    };
  }
  if (gotId === idVal || idType !== 0 || boxIndex !== null) {
    return { ok: false, uncertain: true, reason: "写入状态不明：槽位已被触碰但未达期望类型，禁止自动重试" };
  }
  return { ok: false, reason: "写入未生效（槽位仍为空）" };
}

function identity(obj: REManagedObject): string | undefined {
  try { return String(obj.get_address()); } catch { return undefined; }
}
export interface GrantedEntry { boxIndex: number; idVal: number; idType: number; identity?: string; fingerprint?: string; acceptedFingerprints?: string[]; removed?: boolean }

function recordedEntry(box: REManagedObject, entry: GrantedEntry, relocated = false): REManagedObject | null {
  const hint = boxEntry(box, entry.boxIndex);
  if (!hint) throw new Error("Recorded equipment slot unavailable; cleanup retained");
  if (hint.get_field("_IdType") === 0) return null;
  if (hint.get_field("_IdType") !== entry.idType || hint.get_field("_IdVal") !== entry.idVal ||
      (relocated ? !entry.fingerprint || ![entry.fingerprint, ...(entry.acceptedFingerprints ?? [])].includes(equipmentFingerprint(hint)) :
        entry.identity !== undefined && identity(hint) !== entry.identity))
    throw new Error("Equipment ownership uncertain; refusing to delete a matching user item");
  return hint;
}

export interface StartupWearReport {
  ok: boolean;
  armor: string;
  /** 原装 pack（恢复真值）。读到 pack 后的失败路径也会返回。 */
  prevPack: number[] | null;
  wornPack: number[] | null;
  /** 本局新发放（非复用）的条目，局末清理用。 */
  granted: GrantedEntry[];
  pouchIsolated: boolean;
  pouchReason?: string;
  /** 失败路径是否已尝试回滚（原装 pack + 撤销新发条目）。 */
  rollbackAttempted?: boolean;
  reason?: string;
}

export interface EquipWearPort {
  /** 供 NativeRuntime 注入的袋隔离动作（pouch_backup）。 */
  beginPouchIsolation(): { ok: boolean; reason?: string; recoveryRequired?: boolean };
  endPouchIsolation(retainUntilSave?: boolean): { ok: boolean; reason?: string };
}

const STATE_FILE = "mhw_rogue_startup_state.json";

interface PersistedState {
  wardrobeId?: string;
  wardrobeRevision?: number;
  inheritedWeapon?: number;
  runJewels?: Record<string, number>;
  runSockets?: Record<string, number[]>;
  schema?: number;
  owner?: RecoveryOwner;
  originalBox?: EquipmentSnapshot;
  originalMySet?: EquipmentMySet;
  wornMySet?: EquipmentMySet;
  active: boolean;
  armor: string | null;
  prevPack: number[];
  granted: GrantedEntry[];
  pouchIsolated: boolean;
  wornPack?: number[];
  phase?: "restored";
  restoredProcess?: string;
}

export function persistStartupState(state: PersistedState | null): boolean {
  try {
    return writeRecoveryRecord(STATE_FILE, state ?? { active: false, armor: null, prevPack: [],
      granted: [], pouchIsolated: false });
  } catch (error) {
    relog.error(`[MhwRogue] startup journal failed: ${String(error)}`);
    return false;
  }
}

export function loadStartupState(): PersistedState | null {
  const raw = readRecoveryRecord<PersistedState>(STATE_FILE);
  if (!raw || raw.active !== true) return null;
  // REFramework serializes an empty Lua array as JSON null.
  raw.prevPack = raw.prevPack ?? [];
  raw.granted = raw.granted ?? [];
  if (!Array.isArray(raw.prevPack) || ![0, PACK_LEN].includes(raw.prevPack.length) ||
      raw.prevPack.some(v => !Number.isInteger(v) || v < -1) || !Array.isArray(raw.granted) ||
      raw.granted.some(e => !e || !Number.isInteger(e.boxIndex) || e.boxIndex < 0 ||
        !Number.isInteger(e.idVal) || e.idVal <= 0 || ![1, 2].includes(e.idType)) || typeof raw.pouchIsolated !== "boolean")
    throw new Error("装备恢复记录无效；保留原备份，禁止开新局");
  assertRecoveryOwner(raw.owner);
  raw.runJewels ??= {}; raw.runSockets ??= {};
  if(Object.entries(raw.runJewels).some(([id,n])=>!Number.isInteger(Number(id))||Number(id)<=0||!Number.isInteger(n)||n<0||n>100000)||
     Object.entries(raw.runSockets).some(([key,values])=>!raw.granted.some(e=>String(e.boxIndex)===key)||!Array.isArray(values)||values.length!==3||values.some(id=>!Number.isInteger(id)||id<0))||
     raw.granted.some(e=>e.acceptedFingerprints!==undefined&&(!Array.isArray(e.acceptedFingerprints)||e.acceptedFingerprints.length>4||e.acceptedFingerprints.some(fp=>typeof fp!=="string"||fp.length!==64))))
    throw new Error("局内珠子事务记录无效，保留备份");
  const allocated:Record<string,number>={};
  for(const values of Object.values(raw.runSockets))for(const id of values)if(id>0)allocated[String(id)]=(allocated[String(id)]??0)+1;
  if(Object.entries(allocated).some(([id,n])=>n>(raw.runJewels![id]??0)))throw new Error("局内珠子数量记录不一致，保留备份");
  if (raw.wornPack !== undefined && (!Array.isArray(raw.wornPack) || raw.wornPack.length !== PACK_LEN ||
      raw.wornPack.some(v => !Number.isInteger(v) || v < -1))) throw new Error("本局装备索引恢复记录无效");
  if (raw.schema === 4) {
    if (raw.prevPack.length > 0 && !raw.originalMySet) throw new Error("原装备个人组合缺失");
    if (raw.originalMySet) {
      validateEquipmentMySet(raw.originalMySet);
      if (raw.prevPack.some((v,i) => v !== raw.originalMySet!.indices[i])) throw new Error("原装备索引与个人组合不一致");
    }
    if (raw.wornMySet) {
      validateEquipmentMySet(raw.wornMySet);
      if (!raw.wornPack || raw.wornPack.some((v,i) => v !== raw.wornMySet!.indices[i])) throw new Error("本局装备索引与个人组合不一致");
    }
  }
  if (raw.schema === 3 || raw.schema === 4) {
    if (!raw.originalBox) throw new Error("Original equipment box snapshot missing");
    validateEquipmentSnapshot(raw.originalBox);
  }
  return raw;
}

export function startupRecoveryPending(): boolean {
  return recoveryPending(STATE_FILE) || recoveryPending("mhw_rogue_pouch_state.json");
}

function runState(): PersistedState {
  const state = loadStartupState();
  if (!state || state.phase === "restored" || state.schema !== 4 || !state.wornPack || !state.originalBox)
    throw new Error("当前没有可调整的局内装备箱");
  if(state.granted.some(e=>e.acceptedFingerprints))throw new Error("镶嵌事务尚待恢复，请结束本局并保留日志");
  return state;
}
function runEntry(state: PersistedState, index: number): {entry: GrantedEntry; object: REManagedObject} {
  const entry = state.granted.find(e => e.boxIndex === index && !e.removed);
  const box = equipmentBox(dataManager());
  if (!entry || !box) throw new Error("只能操作本局登记的装备实例");
  const object = recordedEntry(box, entry, true);
  if (!object) throw new Error("本局装备已不存在");
  return {entry, object};
}
function equipPosition(entry: GrantedEntry): number {
  if (entry.idType === 1) return 0;
  const part = Math.floor(entry.idVal / 0x100000) % 16;
  if (part < 1 || part > 5) throw new Error("不支持的装备部位");
  return part;
}
function socketLevels(object:REManagedObject):number[]{
  const list=object.call("getDecorationsSlotList") as REManagedObject|null;
  if(!list)throw new Error("原生孔位不可读");
  const n=list.call("get_Count") as number;
  if(!Number.isInteger(n)||n<0||n>3)throw new Error("原生孔位数量无效");
  const levels:number[]=[];
  for(let i=0;i<n;i++){
    const slot=list.call("get_Item",i) as REManagedObject;
    const level=slot.call("get_SlotLv") as number;
    if(!Number.isInteger(level)||level<1||level>4)throw new Error("原生孔位等级无效");
    levels.push(level);
  }
  return levels;
}
export function runEquipmentSnapshot() {
  try {
    const state = runState(), edm = equipDataManager(), pack = readPack(edm);
    if (!edm || !pack) throw new Error("穿戴状态不可读");
    const items = state.granted.filter(e => !e.removed).map(e => {
      const {object} = runEntry(state, e.boxIndex);
      const levels=socketLevels(object);
      return {key:e.boxIndex, id:e.idVal, position:equipPosition(e), name:object.call("getName") as string,
        worn:pack[equipPosition(e)]===e.boxIndex, inherited:false,
        slotLevels:levels,sockets:levels.map((_,i) => object.call("getDecoId",i) as number)};
    });
    const originalWeapon = state.inheritedWeapon;
    if (originalWeapon !== undefined && originalWeapon >= 0 && !items.some(e => e.position === 0 && e.key === originalWeapon)) {
      const weapon = boxEntry(equipmentBox(dataManager()),originalWeapon);
      if (!weapon || equipmentFingerprint(weapon) !== state.originalBox!.entries[String(originalWeapon)])
        throw new Error("继承武器已变化，暂停装备操作");
      items.unshift({key:originalWeapon,id:weapon.get_field("_IdVal") as number,position:0,
        name:weapon.call("getName") as string,worn:pack[0]===originalWeapon,inherited:true,slotLevels:[],sockets:[]});
    }
    const used: Record<string,number> = {};
    for (const values of Object.values(state.runSockets ?? {})) for (const id of values) if (id > 0) used[String(id)] = (used[String(id)] ?? 0) + 1;
    return {version:`${state.wardrobeId ?? state.owner?.process}:${state.wardrobeRevision??0}`,items,
      jewels:Object.entries(state.runJewels ?? {}).map(([id,count]) => ({id:Number(id),name:runJewelName(Number(id)),level:runJewelLevel(Number(id)),count,available:count-(used[id]??0)})),reason:null};
  } catch (error) { return {version:"",items:[],jewels:[],reason:String(error)}; }
}
/** Personal wardrobe changes always execute in the native equipment update. */
export function wearRunEquipment(index: number): void {
  requireEquipmentUpdate();
  const state=runState(), edm=equipDataManager();
  if (!edm || !Number.isInteger(index)) throw new Error("装备请求无效");
  const snapshot=runEquipmentSnapshot();
  if (snapshot.reason) throw new Error(snapshot.reason);
  const item=snapshot.items.find(e=>e.key===index);
  if (!item) throw new Error("该实例不属于局内装备箱");
  const pack=readPack(edm);
  if (!pack) throw new Error("穿戴状态不可读");
  const previous=captureEquipmentMySet(edm);
  pack[item.position]=index;
  try {
    applyEquipmentIndices(edm,pack);
    state.wornPack=pack; state.wornMySet=captureEquipmentMySet(edm);
    state.wardrobeRevision=(state.wardrobeRevision??0)+1;
    if (!persistStartupState(state)) throw new Error("局内穿戴记录写入失败");
  } catch (error) { applyEquipmentIndices(edm,previous.indices); throw error; }
}

/** Run jewels are entitlements, separate from the player's native jewel stock.
 * No native inventory-counting overload is used for these temporary sockets. */
export function grantRunJewel(id:number): void {
  if (!Number.isInteger(id)||id<=0) throw new Error("珠子 ID 无效");
  runJewelName(id); // Reject unavailable native catalogue IDs before registering a reward.
  const state=runState(); state.runJewels ??= {};
  state.runJewels[String(id)]=(state.runJewels[String(id)]??0)+1;
  state.wardrobeRevision=(state.wardrobeRevision??0)+1;
  if (!persistStartupState(state)) throw new Error("本局珠子登记失败");
}
function decorationNative(object:REManagedObject,method:string,...args:unknown[]): unknown {
  const type=findTypeDefinition("snow.data.EquipmentInventoryData");
  if (!type?.get_method(method)) throw new Error("原生镶嵌接口不可用");
  return callNativeFunction(object,type,method,...args);
}
function setSocket(object:REManagedObject,slot:number,id:number):void {
  if (id===0) decorationNative(object,"removeDecorations",slot,false);
  else decorationNative(object,"setDecorations(System.Int32, snow.equip.DecorationsId, System.Boolean)",slot,id,false);
  if (object.call("getDecoId",slot)!==id) throw new Error("镶嵌读回不一致");
}
export function socketRunJewel(index:number,slot:number,id:number):void {
  requireEquipmentUpdate();
  if (!Number.isInteger(slot)||slot<0||slot>2||!Number.isInteger(id)||id<0) throw new Error("镶嵌请求无效");
  const state=runState(), {entry,object}=runEntry(state,index), edm=equipDataManager();
  if (!edm) throw new Error("装备管理器不可用");
  const old=[0,1,2].map(i=>object.call("getDecoId",i) as number);
  const tracked=state.runSockets?.[String(index)] ?? [0,0,0];
  if (old.some((v,i)=>v!==tracked[i])) throw new Error("装备珠子与局内记录不一致，保留现场");
  if (old[slot]===id) return;
  const levels=socketLevels(object);
  if(slot>=levels.length||id>0&&runJewelLevel(id)>levels[slot]!)throw new Error("珠子不符合原生孔位等级");
  if (id>0 && !runEquipmentSnapshot().jewels.some(j=>j.id===id&&j.available>0)) throw new Error("没有可用的本局珠子");
  // Validate on an independent copy before touching the live temporary item.
  const scratch=createInstance("snow.data.EquipmentInventoryData");
  if (!scratch) throw new Error("无法预检镶嵌");
  retainEquipmentObject(scratch); decorationNative(scratch,".ctor"); decorationNative(scratch,"copy",object);
  setSocket(scratch,slot,0);
  const empty=equipmentFingerprint(scratch);
  setSocket(scratch,slot,id);
  decorationNative(scratch,"removeNotFitDecoSlot",false);
  if (scratch.call("getDecoId",slot)!==id || decorationNative(scratch,"checkDecoCheat")!==false)
    throw new Error("珠子不符合原生孔位或合法性规则");
  const before=entry.fingerprint, after=equipmentFingerprint(scratch);
  entry.acceptedFingerprints=[before!,empty,after];
  // Both transaction endpoints are durable before the native write. On interruption
  // recovery may safely reclaim either version of this exact temporary instance.
  if (!persistStartupState(state)) throw new Error("镶嵌事务登记失败");
  try {
    setSocket(object,slot,id);
    const pack=readPack(edm); if (!pack) throw new Error("穿戴状态不可读");
    applyEquipmentIndices(edm,pack);
    state.runSockets ??= {}; const next=old.slice(); next[slot]=id; state.runSockets[String(index)]=next;
    entry.fingerprint=equipmentFingerprint(object); entry.acceptedFingerprints=undefined;
    state.wornPack=pack; state.wornMySet=captureEquipmentMySet(edm);
    state.wardrobeRevision=(state.wardrobeRevision??0)+1;
    if (!persistStartupState(state)) throw new Error("镶嵌结果落盘失败，保留事务以供恢复");
  } catch(error) { throw new Error(`镶嵌结果需核验，请结束本局恢复：${String(error)}`); }
}

function clearRunSockets(state:PersistedState,box:REManagedObject):void {
  for(const entry of state.granted){
    if (!state.runSockets?.[String(entry.boxIndex)] && !entry.acceptedFingerprints) continue;
    const object=recordedEntry(box,entry,true); if(!object) continue;
    const scratch=createInstance("snow.data.EquipmentInventoryData");
    if(!scratch) throw new Error("无法登记珠子回收");
    retainEquipmentObject(scratch);decorationNative(scratch,".ctor");decorationNative(scratch,"copy",object);
    const fingerprints=[equipmentFingerprint(object)];
    for(let i=0;i<3;i++){setSocket(scratch,i,0);fingerprints.push(equipmentFingerprint(scratch));}
    entry.acceptedFingerprints=fingerprints;
    if(!persistStartupState(state)) throw new Error("珠子回收事务写入失败");
    for(let i=0;i<3;i++)setSocket(object,i,0);
    entry.fingerprint=equipmentFingerprint(object);entry.acceptedFingerprints=undefined;
    if(state.runSockets)delete state.runSockets[String(entry.boxIndex)];
    if(!persistStartupState(state))throw new Error("珠子回收结果写入失败");
  }
}

/**
 * 开局穿戴：保存原装 → 按规则卸护石/虫笼 → 发放并穿上五件 → 读回核验。
 * 任一步失败：尝试回滚原装 pack 并撤销本局新发条目，然后报告失败（不抛异常）。
 * 袋隔离只在装备全部成功后执行；隔离失败则回滚并拒绝开局。
 */
export function equipStartupSet(armor: string, series: number, rules: StartupRules,
  pouch: EquipWearPort | null): StartupWearReport {
  const report: StartupWearReport = { ok: false, armor, prevPack: null, wornPack: null, granted: [], pouchIsolated: false };
  const edm = equipDataManager();
  const box = equipmentBox(dataManager());
  if (!edm || !box) {
    report.reason = "EquipDataManager/EquipBox unavailable";
    return report;
  }
  let owner: RecoveryOwner;
  try {
    if (loadStartupState()) {
      report.reason = "Previous startup recovery must finish before starting another run";
      return report;
    }
    owner = readRecoveryOwner();
  } catch (error) {
    report.reason = String(error); return report;
  }
  // Check the entire proposal before stripping gear, journaling or granting its
  // first piece. A valid encoding alone does not prove that a series exists.
  if (!Number.isInteger(series) || series < 0 || series >= 0x100000)
    return {...report,reason:"防具系列号必须是 0–1048575 的整数"};
  for (const part of [1,2,3,4,5] as const) {
    const reason = equipmentUnavailableReason("armor", armorId(series,part));
    if (reason) return {...report,reason:`初始防具部位 ${part}：${reason}`};
  }
  if (!rules.keepPlayerWeapon && rules.weaponId !== null) {
    const reason = equipmentUnavailableReason("weapon", rules.weaponId);
    if (reason) return {...report,reason};
  }
  const prev = readPack(edm);
  if (!prev) {
    report.reason = "PlEquipPack 不可读";
    return report;
  }
  report.prevPack = prev.slice();

  const granted: GrantedEntry[] = [];
  let originalBox: EquipmentSnapshot;
  try { originalBox = captureEquipmentBox(box); }
  catch (error) { return { ...report, reason:String(error) }; }
  let originalMySet: EquipmentMySet;
  try { originalMySet = captureEquipmentMySet(edm); }
  catch (error) { return { ...report, reason:String(error) }; }
  const journal: PersistedState = { schema:4, active: true, owner, originalBox, originalMySet, armor, prevPack: prev, granted, pouchIsolated: false,
    wardrobeId:`${clockSeconds()}-${Math.random()}`,
    inheritedWeapon:rules.keepPlayerWeapon ? prev[0] : undefined };
  if (!persistStartupState(journal)) { report.reason = recoveryWriteFailure() ?? "Cannot save original equipment"; return report; }
  const reserve = (entry: GrantedEntry): boolean => {
    granted.push(entry);
    return persistStartupState(journal);
  };
  const fail = (reason: string): StartupWearReport => {
    const rollback = restoreStartup(pouch);
    return { ...report, ok:false, granted, rollbackAttempted: true,
      reason: `${reason}; recovery ${rollback.ok ? "completed" : "pending: " + rollback.reason}` };
  };

  const desired = prev.slice();
  for (const [pos, strip] of [[PACK_TALISMAN, rules.stripTalismans], [PACK_INSECT, rules.stripInsect]] as const) {
    if (strip) desired[pos] = -1;
  }

  for (let part = 1 as 1 | 2 | 3 | 4 | 5; part <= 5; part++) {
    const id = armorId(series, part);
    const grant = grantEquip(box, id, "armor", reserve, false, () => persistStartupState(journal));
    if (!grant.ok || grant.boxIndex === undefined) {
      return fail(`防具发放失败（部位 ${part}）: ${grant.reason ?? "未知"}${grant.uncertain ? "［结果不明，禁止自动重试］" : ""}`);
    }

    desired[part] = grant.boxIndex;
  }

  // D1 武器口子：keepPlayerWeapon=false 时按 weaponId 发放并穿上（配置校验保证非空）
  if (!rules.keepPlayerWeapon && rules.weaponId !== null) {
    const grant = grantEquip(box, rules.weaponId, "weapon", reserve, false, () => persistStartupState(journal));
    if (!grant.ok || grant.boxIndex === undefined) {
      return fail(`武器发放失败: ${grant.reason ?? "未知"}`);
    }

    desired[PACK_WEAPON] = grant.boxIndex;
  }

  try { applyEquipmentIndices(edm, desired); }
  catch (error) { return fail(`原生穿装失败：${String(error)}`); }
  const finalPack = readPack(edm);
  if (!finalPack) {
    return fail("终态 pack 不可读");
  }
  for (let part = 1; part <= 5; part++) {
    const expected = granted.find(e => e.idVal === armorId(series, part as 1 | 2 | 3 | 4 | 5))?.boxIndex ?? null;
    if (expected === null || finalPack[part] !== expected) {
      return fail(`穿装读回不一致：pack[${part}]=${finalPack[part]} 期望 ${expected}`);
    }
  }
  if (rules.stripTalismans && finalPack[PACK_TALISMAN] !== -1) {
    return fail("护石未卸下（pack[7] 读回非 -1）");
  }

  report.ok = true;
  report.wornPack = finalPack;
  journal.wornPack = finalPack.slice();
  try { journal.wornMySet = captureEquipmentMySet(edm); }
  catch (error) { return fail(`本局个人组合备份失败：${String(error)}`); }
  report.granted = granted;
  if (pouch) {
    // Arm recovery BEFORE any pouch mutation, including partially failed clears.
    journal.pouchIsolated = true;
    if (!persistStartupState(journal)) return fail("Cannot journal pouch recovery");
    const pouchReport = pouch.beginPouchIsolation();
    journal.pouchIsolated = pouchReport.recoveryRequired !== false;
    report.pouchIsolated = journal.pouchIsolated;
    report.pouchReason = pouchReport.ok ? undefined : pouchReport.reason;
    if (!pouchReport.ok) return fail(pouchReport.reason ?? "Pouch isolation failed");
  }
  if (!persistStartupState(journal)) return fail("Cannot save startup completion");
  return report;
}

/**
 * 把非开局发放的装备（抽取/掉落）并入局末清理清单。
 * 无活动状态时构造只含发件的记录（prevPack 置空标记"恢复期跳过 pack 写回"）。
 */
export function appendGrantedEntry(entry: GrantedEntry): boolean {
  try {
    const state = loadStartupState();
    const merged: PersistedState = state ?? {
      schema:3, active: true, owner: readRecoveryOwner(), originalBox:captureEquipmentBox(equipmentBox(dataManager())!),
      armor: null, prevPack: [], granted: [], pouchIsolated: false,
    };
    if (merged.granted.some(e => !e.removed && e.boxIndex === entry.boxIndex)) return false;
    merged.active = true;
    merged.granted = merged.granted.concat([entry]);
    return persistStartupState(merged);
  } catch {
    return false;
  }
}

export function confirmGrantedEntry(entry: GrantedEntry): boolean {
  try {
    const state = loadStartupState();
    const reserved = state?.granted.find(e => !e.removed && e.boxIndex === entry.boxIndex && e.idVal === entry.idVal && e.idType === entry.idType);
    if (!state || !reserved || !entry.fingerprint) return false;
    reserved.fingerprint = entry.fingerprint;
    return persistStartupState(state);
  } catch { return false; }
}

export interface RestoreReport {
  ok: boolean;
  awaitingSave?: boolean;
  restoredPack?: boolean;
  removedEntries?: number;
  skippedEntries?: number;
  pouchRestored?: boolean;
  reason?: string;
}

/**
 * 回村恢复（幂等）：核验角色 → 恢复 pack/道具袋 → 清理本局发件 → 退役记录。
 * 无待恢复状态时返回 ok=true 的 no-op；失败保持待办（调用方稍后重试）。
 */
export function restoreStartup(pouch: EquipWearPort | null, retainUntilSave = false): RestoreReport {
  let state: PersistedState | null;
  try { state = loadStartupState(); }
  catch (error) { return { ok: false, reason: String(error) }; }
  if (!state) {
    const restored = pouch?.endPouchIsolation(retainUntilSave);
    if (restored && !restored.ok) return { ok: false, reason: restored.reason };
    return { ok: true, restoredPack: false, removedEntries: 0, skippedEntries: 0, pouchRestored: false };
  }
  const edm = equipDataManager();
  const box = equipmentBox(dataManager());
  if (!edm) {
    return { ok: false, reason: "EquipDataManager unavailable；恢复保持待办" };
  }
  const process = readRecoveryOwner().process;
  const relocated = state.owner?.process !== process;
  // Character reloads and native return backups may resurrect removed items,
  // even within the same process. Reconcile live contents before certification.
  const reconcileSaved = relocated || state.phase === "restored";
  if (reconcileSaved) {
    try {
      if (!box || !state.originalBox) throw new Error("跨进程恢复缺少原装备箱完整指纹，保留待办");
      // A prior native save can still contain entries removed only in memory.
      verifyEquipmentBox(box, state.originalBox, state.granted, true);
    } catch (error) { return {ok:false,reason:String(error)}; }
  }
  const result: RestoreReport = { ok: true, restoredPack: false, removedEntries: 0, skippedEntries: 0, pouchRestored: false };
  const removed = (): number => (result.removedEntries ?? 0);
  const skipped = (): number => (result.skippedEntries ?? 0);
  try { if(box) clearRunSockets(state,box); }
  catch(error){return {...result,ok:false,reason:String(error)};}
  // prevPack 为空 = 该记录只含发件清理（抽取/掉落），没有 pack 恢复语义
  if (state.prevPack.length === PACK_LEN) {
    try {
      if (state.originalMySet) {
        if (!equipmentMySetMatches(edm, state.originalMySet)) applyEquipmentMySet(edm, state.originalMySet);
        verifyReferences(edm.call("get_PlEquipPack") as REManagedObject, state.prevPack);
      }
      else applyEquipmentIndices(edm, state.prevPack); // Legacy schema3 recovery.
      result.restoredPack = true;
    } catch (error) {
      return { ...result, ok:false, reason:`原生装备恢复待办：${String(error)}` };
    }
  }
  // Original resources can be restored even if a temporary item's ownership
  // cannot be proven after a process restart. Keep the cleanup journal pending.
  if (state.pouchIsolated) {
    if (!pouch) return { ...result, ok:false, reason:"道具袋恢复器不可用；恢复保持待办" };
    const restored = pouch.endPouchIsolation(retainUntilSave);
    if (!restored.ok) return { ...result, ok:false, reason:restored.reason };
    result.pouchRestored = true;
    if (!retainUntilSave) {
      state.pouchIsolated = false;
      if (!persistStartupState(state)) return { ...result, ok:false, reason:"Cannot save pouch recovery progress" };
    }
  }
  for (const entry of state.granted) {
    if (entry.removed && !reconcileSaved) continue;
    if (!box) return { ...result, ok: false, reason: "Equipment box unavailable" };
    try {
      const obj = recordedEntry(box, entry, reconcileSaved);
      if (obj) {
        box.call("subEquipment", obj);
        // 读回=记录的槽位已空（同 id 双件合法并存，全箱 id 消失不是必要条件）
        const slot = boxEntry(box, entry.boxIndex);
        if (slot && slot.get_field("_IdType") !== 0) throw new Error("Equipment removal readback failed");
        result.removedEntries = removed() + 1;
      } else result.skippedEntries = skipped() + 1;
      if (!entry.removed) {
        entry.removed = true;
        if (!persistStartupState(state)) throw new Error("Cannot save cleanup progress");
      }
    } catch (error) {
      return { ...result, ok: false, reason: String(error) };
    }
  }
  if (retainUntilSave) {
    if (state.phase!=="restored" || state.restoredProcess!==process) {
      state.phase = "restored"; state.restoredProcess = process;
      if (!persistStartupState(state)) return {...result,ok:false,reason:"Cannot retain recovery until native save"};
    }
    return {...result,awaitingSave:true};
  }
  // Immediate retirement is only for a synchronous, unsaved grant rollback.
  if (!persistStartupState(null)) return { ...result, ok: false, reason: "Cannot retire recovery journal" };
  relog.info(`[MhwRogue] 开局装备已恢复（发件清理 ${result.removedEntries}/${state.granted.length}）`);
  return result;
}

/** Only a restored live inventory can be certified by a subsequent native save. */
export function startupCommitRecord(): PersistedState | null | undefined {
  const state = loadStartupState();
  if (!state) return null;
  if (state.phase !== "restored" || state.restoredProcess !== readRecoveryOwner().process) return undefined;
  const box = equipmentBox(dataManager());
  if (!box || !state.originalBox) throw new Error("Original equipment save verification unavailable");
  verifyEquipmentBox(box,state.originalBox,[]);
  const pack = readPack(equipDataManager());
  if (state.prevPack.length > 0 && (!pack || pack.some((v,i)=>v!==state.prevPack[i])))
    throw new Error("Restored equipment changed before native save");
  if (state.prevPack.length > 0) verifyReferences(equipDataManager()!.call("get_PlEquipPack") as REManagedObject, state.prevPack);
  return state;
}

/** The engine may restore its own equipment backup on quest return. */
export function reapplyStartup(): { ok: boolean; reason?: string } {
  try {
    const state = loadStartupState();
    if (!state?.wornPack) return { ok: true }; // Legacy recovery-only journals.
    const edm = equipDataManager();
    if (!edm || state.wornPack.length !== PACK_LEN) throw new Error("Run equipment snapshot unavailable");
    const box = equipmentBox(dataManager());
    if (!box) throw new Error("Equipment box unavailable");
    for (const entry of state.granted) if (!entry.removed && !recordedEntry(box, entry)) throw new Error("Run equipment disappeared");
    if (Object.values(state.runSockets??{}).some(values=>values.some(id=>id>0))) {
      // Run jewels never consume/return native stock through a saved-set application.
      applyEquipmentIndices(edm,state.wornPack);
    } else if (state.wornMySet) {
      if (!equipmentMySetMatches(edm, state.wornMySet)) applyEquipmentMySet(edm, state.wornMySet);
      verifyReferences(edm.call("get_PlEquipPack") as REManagedObject, state.wornPack);
    }
    else applyEquipmentIndices(edm, state.wornPack);
    return { ok: true };
  } catch (error) { return { ok: false, reason: String(error) }; }
}
