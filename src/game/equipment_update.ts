import { clockSeconds, findTypeDefinition, hookMethod, relog, type REManagedObject } from "./sdk";

interface Work { key: object; run: () => void; fail: (reason: string) => void; deadline: number }
let installed = false;
let updating = false;
let queue: Work[] = [];
let frame = 0;
let retained: { object: REManagedObject; until: number }[] = [];
/** add_ref is tracked by REFramework's Lua wrapper and released on collection. */
export function retainEquipmentObject(object: REManagedObject): void {
  object.add_ref(); retained.push({ object, until: frame + 60 });
}

export function inEquipmentUpdate(): boolean { return updating; }
export function requireEquipmentUpdate(): void {
  if (!updating) throw new Error("装备操作必须在原生 EquipDataManager.update 中执行");
}

/** One native mutation at a time. Render/UI callbacks enqueue intents, never block.
 * Keys coalesce repeated frame requests; callbacks must revalidate their live scope.
 * Expired/reset work must not replay against a later character or session. */
export function enqueueEquipmentWork(key: object, run: () => void, fail: (reason: string) => void): void {
  if (queue.some(w => w.key === key)) return;
  if (!installed) {
    const method = findTypeDefinition("snow.data.EquipDataManager")?.get_method("update");
    if (!method) throw new Error("原生装备更新入口不可用");
    hookMethod(method, undefined, retval => {
      if (updating) return retval;
      frame++;
      retained = retained.filter(x => x.until > frame);
      const work = queue.shift();
      if (!work) return retval;
      updating = true;
      try {
        if (clockSeconds() > work.deadline) throw new Error("等待装备更新超时，请重新操作");
        work.run();
      } catch (error) {
        try { work.fail(String(error)); }
        catch (nested) { relog.error(`[MhwRogue] native loadout task: ${String(nested)}`); }
      } finally { updating = false; }
      return retval;
    });
    installed = true;
  }
  if (queue.length >= 16) throw new Error("原生装备操作队列已满");
  queue.push({ key, run, fail, deadline: clockSeconds() + 10 });
}

export function cancelEquipmentWork(key: object): void { queue = queue.filter(w => w.key !== key); }
