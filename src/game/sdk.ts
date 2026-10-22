/**
 * Platform 层（架构纪律：REFramework 全局 API 只允许出现在本文件）。
 *
 * 这些 `declare const` 是 REFramework 注入的 Lua 全局（REFramework book:
 * https://cursey.github.io/reframework-book）。它们是模块内环境声明：
 * 仅本文件可见、TSTL 编译时原样保留标识符、不产生任何运行时代码。
 * 其他文件（包括 src/core）引用这些全局会直接编译失败。
 *
 * 用法均经本仓库 free_arena.lua 与 AutoQuest 研究代码实机验证。
 */

/* ---------- REFramework 全局（Lua 侧原样保留） ---------- */

declare const log: {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  debug(msg: string): void;
};

declare const json: {
  load_file(path: string): unknown;
  dump_file(path: string, data: unknown, pretty?: boolean): boolean;
};

declare const re: {
  on_frame(cb: () => void): void;
  on_draw_ui(cb: () => void): void;
  on_script_reset(cb: () => void): void;
};

declare const imgui: {
  text(text: string): void;
  text_disabled(text: string): void;
  text_colored(r: number, g: number, b: number, a: number, text: string): void;
  button(label: string): boolean;
  separator(): void;
  spacing(): void;
  same_line(): void;
  tree_node(label: string): boolean;
  tree_pop(): void;
};

declare const thread: {
  get_hook_storage(): Record<string, unknown>;
};

declare const sdk: {
  get_managed_singleton(name: string): REManagedObject | null;
  find_type_definition(name: string): RETypeDefinition | null;
  create_instance(typeName: string, simplify?: boolean): REManagedObject | null;
  create_managed_string(value: string): REManagedObject;
  hook(
    method: REMethodDefinition,
    pre?: (args: unknown[]) => number | void,
    post?: (retval: unknown) => unknown,
  ): void;
  to_managed_object(value: unknown): REManagedObject;
  to_ptr(value: unknown): unknown;
  to_int64(value: unknown): number;
};

/* ---------- RE Engine 类型（最小面） ---------- */

export interface REManagedObject {
  get_field(name: string): unknown;
  set_field(name: string, value: unknown): void;
  call(name: string, ...args: unknown[]): unknown;
  add_ref(): void;
  get_type_definition(): RETypeDefinition;
}

export interface REField {
  get_name(): string;
  is_static(): boolean;
}

export interface RETypeDefinition {
  get_full_name(): string;
  get_fields(): REField[];
  get_method(name: string): REMethodDefinition | null;
}

export interface REMethodDefinition {
  get_name(): string;
}

export const PRE_HOOK = { CALL_ORIGINAL: 0, SKIP_ORIGINAL: 1 } as const;

/* ---------- 类型化封装（游戏层唯一入口） ---------- */

export function getSingleton(name: string): REManagedObject | null {
  return sdk.get_managed_singleton(name);
}

export function questManager(): REManagedObject | null {
  return sdk.get_managed_singleton("snow.QuestManager");
}

/** 保留引用防 GC（free_arena.lua 的 retain 模式）。 */
export function retain<T extends REManagedObject>(obj: T, pool: REManagedObject[]): T {
  if (!obj) throw new Error("retain: object is nil");
  obj.add_ref();
  pool.push(obj);
  return obj;
}

export const hookMethod = sdk.hook;
export const toManagedObject = sdk.to_managed_object;
export const toPtr = sdk.to_ptr;
export const createManagedString = sdk.create_managed_string;
export const createInstance = sdk.create_instance;

export const reframework = {
  onFrame: re.on_frame,
  onDrawUi: re.on_draw_ui,
  onScriptReset: re.on_script_reset,
  getHookStorage: thread.get_hook_storage,
};

export const relog = log;
export const rejson = json;
export const imguiApi = imgui;
