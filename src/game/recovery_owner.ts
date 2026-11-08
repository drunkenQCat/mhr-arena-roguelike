import { getSingleton, loadWebconsole, type REManagedObject } from "./sdk";

export interface RecoveryOwner { character: string; slot: number; name: string; process: string }

/** GuildCardID is serialized per character. Read its integer components instead
 * of an overloaded ToString() (the installed binding can select a wrong overload). */
export function readRecoveryOwner(): RecoveryOwner {
  const save = getSingleton("snow.SnowSaveService");
  const slot = save?.call("getSlotNo") as number;
  if (!Number.isInteger(slot) || slot < 0 || slot > 2) throw new Error("尚未加载可确认的角色，等待载入后恢复");
  const card = (getSingleton("snow.GuildCardManager")?.get_field("_GuildCard") as REManagedObject | null)
    ?.get_field("MyData") as REManagedObject | null;
  const guid = card?.get_field("GuildCardID") as REManagedObject | null;
  const names = ["mData1", "mData2", "mData3", "mData4_0", "mData4_1", "mData4_2", "mData4_3", "mData4_4", "mData4_5", "mData4_6", "mData4_7"];
  const values = names.map((n, i) => {
    const value = guid?.get_field(n) as number;
    const max = i === 0 ? 0xffffffff : i < 3 ? 0xffff : 0xff;
    if (!Number.isInteger(value) || value < 0 || value > max) throw new Error("原生角色标识不可读，禁止修改装备与背包");
    return value;
  });
  if (values.every(v => v === 0)) throw new Error("原生角色标识尚未初始化");
  const process = loadWebconsole().session_id?.();
  if (typeof process !== "string" || process.length === 0) throw new Error("原生桥进程标识不可用，禁止创建恢复记录");
  const name = save?.call("getCurrentHunterName") as string;
  return { character: values.join(":"), slot, name: typeof name === "string" ? name : "", process };
}

export function assertRecoveryOwner(owner: RecoveryOwner | undefined): RecoveryOwner {
  if (!owner || typeof owner.character !== "string" || typeof owner.process !== "string" ||
      !Number.isInteger(owner.slot) || owner.slot < 0 || owner.slot > 2)
    throw new Error("旧恢复记录缺少可靠角色身份，需先核对并迁移；不会自动写回当前角色");
  const current = readRecoveryOwner();
  if (owner.slot !== current.slot || owner.character !== current.character)
    throw new Error(`恢复属于角色 ${owner.name}（槽${owner.slot + 1}），当前为 ${current.name}；请载入原角色`);
  return current;
}
