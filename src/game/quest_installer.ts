/**
 * 入口任务安装器 —— 自 free_arena.lua 移植（本仓库已实机验证的实现）。
 * 差异点：从"安装"改为"采纳或安装"——若 900101 已被 free_arena 脚本
 * 注册（同 marker / 同 map / 同 timer / 同类型），直接采纳，不与之冲突。
 */

import type { RogueConfig } from "../core/config";
import {
  createInstance,
  createManagedString,
  findTypeDefinition,
  hookMethod,
  PRE_HOOK,
  questManager,
  reframework,
  relog,
  rejson,
  retain,
  toInt64,
  toManagedObject,
  toPtr,
  type REManagedObject,
} from "./sdk";

const QUEST_TYPE_TOUR = 32;
const MARKER = "MhwRogue_FreeArena_v1";

const LABELS: Record<number, string> = {
  0: "斗技场肉鸽 / Arena Roguelike",
  1: "竞技场管理员",
  2: "连续狩猎 Roguelike 模式。\n通过任务菜单完成并返回，无时间限制。",
  3: "斗技场肉鸽任务",
  4: "肉鸽任务不会失败",
};

export class QuestInstaller {
  private installed = false;
  private stopped = false;
  private ticks = 0;
  private status = "Waiting for the quest catalogue";
  private retained: REManagedObject[] = [];

  constructor(private readonly cfg: RogueConfig) {}

  getStatus(): string {
    return this.status;
  }

  isInstalled(): boolean {
    return this.installed;
  }

  /** re.on_frame 驱动；每 ~2 秒尝试一次直到成功或失败。 */
  tick(): void {
    if (this.installed || this.stopped) return;
    this.ticks++;
    if (this.ticks % 120 !== 0) return;
    try {
      this.installed = this.install();
      if (this.installed) {
        this.status = `Installed ${this.cfg.quest.id} / FreeSide TOUR / Map ${this.cfg.quest.mapNo} / no time limit`;
        relog.info(`[MhwRogue] ${this.status}`);
      }
    } catch (e) {
      this.stopped = true;
      this.status = `Install failed: ${e}`;
      relog.error(`[MhwRogue] ${this.status}`);
      rejson.dump_file("mhw_rogue_install.json", { installed: false, error: this.status });
    }
  }

  private retain<T extends REManagedObject>(obj: T | null): T {
    return retain(obj as T, this.retained);
  }

  /** 克隆一个 managed 对象（同类型新实例 + 全部非静态字段拷贝）。 */
  private cloneFields(original: REManagedObject): REManagedObject {
    const td = original.get_type_definition();
    const copy = this.retain(createInstance(td.get_full_name(), true));
    if (!copy) throw new Error(`Cannot allocate ${td.get_full_name()}`);
    for (const field of td.get_fields()) {
      if (!field.is_static()) {
        copy.set_field(field.get_name(), original.get_field(field.get_name()));
      }
    }
    return copy;
  }

  private install(): boolean {
    const qm = questManager();
    if (!qm) return false;
    const dict = qm.get_field("_QuestDataDictionary") as REManagedObject | null;
    if (!dict || !dict.call("ContainsKey", this.cfg.quest.baseId)) return false;

    const id = this.cfg.quest.id;
    if (dict.call("ContainsKey", id)) {
      // 已存在：free_arena 或本脚本的历史安装 → 校验语义一致后采纳
      const existing = toManagedObject(dict.call("get_Item", id)).call("get_RawNormal") as REManagedObject;
      const dbgName = existing.get_field("_DbgName");
      const familiar =
        (dbgName === MARKER || dbgName === "MHRResearch_FreeArena_v1") &&
        existing.get_field("_QuestType") === QUEST_TYPE_TOUR &&
        existing.get_field("_MapNo") === this.cfg.quest.mapNo &&
        existing.get_field("_TimeLimit") === 0;
      if (!familiar) {
        throw new Error(`Quest ID collision: ${id} (${dbgName})`);
      }
      this.installed = true;
      this.status = `Adopted existing quest ${id} (${dbgName})`;
      relog.info(`[MhwRogue] ${this.status}`);
      return true;
    }

    const source = qm.call("getQuestData(System.Int32)", this.cfg.quest.baseId) as REManagedObject;
    const normal = this.cloneFields(toManagedObject(source.call("get_RawNormal")));
    const enemy = this.cloneFields(toManagedObject(source.call("get_RawEnemy")));
    if (normal.get_field("_QuestType") !== QUEST_TYPE_TOUR) throw new Error("Base is not a FreeSide expedition");
    if (normal.get_field("_TimeLimit") !== 0) throw new Error("Base is not untimed");
    normal.set_field("_QuestNo", id);
    normal.set_field("_MapNo", this.cfg.quest.mapNo);
    normal.set_field("_DbgName", MARKER);
    enemy.set_field("_QuestNo", id);
    enemy.set_field("_EmsSetNo", 0);

    const quest = this.retain(createInstance("snow.quest.QuestData", true));
    if (!quest) throw new Error("Cannot allocate snow.quest.QuestData");
    quest.call("set_RawNormal", normal);
    quest.call("set_RawEnemy", enemy);

    // 任务文本：hook getQuestTextCore，仅对 900101 的查询替换文案。
    // 必须返回帧内新建的字符串——缓存串跨调用会在所有权交接处崩溃
    //（本仓库 2026-10-16 崩溃调查结论）。
    const textMethod = findTypeDefinition("snow.quest.QuestData")?.get_method("getQuestTextCore");
    if (!textMethod) throw new Error("Missing quest text API");
    const getStorage = reframework.getHookStorage;
    hookMethod(
      textMethod,
      (args) => {
        const storage = getStorage();
        storage.free_arena_text = null;
        // 与 free_arena.lua 相同的槽位：args[2]=QuestData 身份、args[3]=文本枚举
        if (args[2] === toPtr(quest)) {
          const replacement = LABELS[toInt64(args[3])];
          if (replacement) {
            storage.free_arena_text = replacement;
            return PRE_HOOK.SKIP_ORIGINAL;
          }
        }
        return PRE_HOOK.CALL_ORIGINAL;
      },
      (retval) => {
        const replacement = getStorage().free_arena_text;
        if (replacement) return toPtr(createManagedString(replacement as string));
        return retval;
      },
    );

    // 任务列表：仅在含基础任务 101 的 FreeSide 列表里追加 900101
    const listMethod = qm.get_type_definition().get_method("makeQuestNoList");
    if (!listMethod) throw new Error("Missing quest list API");
    hookMethod(listMethod, undefined, (retval) => {
      const list = toManagedObject(retval);
      if (
        this.installed &&
        list &&
        list.call("Contains", this.cfg.quest.baseId) &&
        !list.call("Contains", id)
      ) {
        list.call("Add", id);
        relog.info("[MhwRogue] added to the FreeSide quest list");
      }
      return retval;
    });

    dict.call("set_Item", id, quest);
    rejson.dump_file("mhw_rogue_install.json", {
      installed: true, backend: "TypeScriptToLua", id, base: this.cfg.quest.baseId,
      menu: "FreeSide", quest_type: QUEST_TYPE_TOUR, map: this.cfg.quest.mapNo, time_limit: 0,
    });
    return true;
  }
}
