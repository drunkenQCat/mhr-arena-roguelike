/**
 * Platform 层（架构纪律：REFramework 全局 API 只允许出现在本文件）。
 *
 * 这些 `declare const` 是 REFramework 注入的 Lua 全局（REFramework book:
 * https://cursey.github.io/reframework-book）。它们是模块内环境声明：
 * 仅本文件可见、TSTL 编译时原样保留标识符、不产生任何运行时代码。
 * 其他文件（包括 src/core）引用这些全局会直接编译失败。
 *
 * @noSelf：REFramework 全局是点调用语义（log.info("x")），
 * 注解让 TSTL 生成点调用而不是 Lua 冒号调用（后者会把宿主表当 self 传入，
 * 实机必错）。REManagedObject 系保持冒号语义（obj:get_field(...)）。
 *
 * 用法均经本仓库 free_arena.lua 与 AutoQuest 研究代码实机验证。
 */

/** @noSelf */
interface RefLog {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  debug(msg: string): void;
}

/** @noSelf */
interface RefJson {
  load_string(text: string): unknown;
  dump_string(data: unknown, indent?: number): string;
  load_file(path: string): unknown;
  dump_file(path: string, data: unknown, indent?: number): boolean;
}

/** @noSelf */
interface RefRe {
  on_frame(cb: () => void): void;
  on_draw_ui(cb: () => void): void;
  on_script_reset(cb: () => void): void;
}

/** @noSelf */
interface RefImgui {
  text(text: string): void;
  text_colored(text: string, color: number): void;
  begin_window(name: string, open: boolean | null, flags?: number): boolean;
  end_window(): void;
  set_next_window_pos(position: number[], condition?: number, pivot?: number[]): void;
  set_next_window_size(size: number[], condition?: number): void;
  button(label: string): boolean;
  separator(): void;
  spacing(): void;
  same_line(): void;
  tree_node(label: string): boolean;
  tree_pop(): void;
}

/** @noSelf */
interface RefThread {
  get_id(): number;
  get_hook_storage(): Record<string, unknown>;
}

/** @noSelf */
interface RefSdk {
  readonly PreHookResult: { readonly CALL_ORIGINAL: number; readonly SKIP_ORIGINAL: number };
  get_managed_singleton(name: string): REManagedObject | null;
  find_type_definition(name: string): RETypeDefinition | null;
  create_instance(typeName: string, simplify?: boolean): REManagedObject | null;
  create_managed_string(value: string): REManagedObject;
  create_managed_array(typeName: string, length: number): REManagedArray;
  to_float(value: unknown): number;
  float_to_ptr(value: number): unknown;
  hook(
    method: REMethodDefinition,
    pre?: (this: void, args: Record<number, unknown>) => number | void,
    post?: (this: void, retval: unknown) => unknown,
  ): void;
  to_managed_object(value: unknown): REManagedObject;
  to_ptr(value: unknown): unknown;
  to_int64(value: unknown): number;
}

declare const log: RefLog;
declare const json: RefJson;
declare const re: RefRe;
declare const imgui: RefImgui;
declare const thread: RefThread;
declare const sdk: RefSdk;
/** @noSelf */
interface RefFs { read(path: string): string; write(path: string, text: string): void; glob(filter: string): string[]; }
declare const fs: RefFs;

declare global {
  /** sol2 usertype wrapping glm::vec3. Its .new constructor is the only supported way
   * to pass a by-value via.vec3 through reflection calls in this build: instances from
   * sdk.create_instance read back fine but invoke as garbage (verified live on em092). */
  // Invoked as Vector3f.new(x, y, z) (a plain property call): TSTL compiles the
  // `new` operator into its own class protocol, which this Lua usertype lacks.
  const Vector3f: { new: (x: number, y: number, z: number) => object };
}

/* ---------- RE Engine 类型（最小面，冒号语义） ---------- */

export interface REManagedObject {
  get_field(name: string): unknown;
  set_field(name: string, value: unknown): void;
  call(name: string, ...args: unknown[]): unknown;
  add_ref(): void;
  release(): void;
  get_address(): unknown;
  get_type_definition(): RETypeDefinition;
}

export interface REManagedArray extends REManagedObject {
  get_size(): number;
  get_element(index: number): unknown;
}

export interface REField {
  get_name(): string;
  is_static(): boolean;
  get_type(): RETypeDefinition;
}

export interface RETypeDefinition {
  get_full_name(): string;
  get_fields(): REField[];
  get_method(name: string): REMethodDefinition | null;
}

export interface REMethodDefinition {
  get_name(): string;
}

export const PRE_HOOK = sdk.PreHookResult;

/* ---------- 类型化封装（游戏层唯一入口） ---------- */

export function getSingleton(name: string): REManagedObject | null {
  return sdk.get_managed_singleton(name);
}

export function questManager(): REManagedObject | null {
  return sdk.get_managed_singleton("snow.QuestManager");
}

/** Explicit escape for verified native signatures missing from the RTTI dump. */
export function unsafeGameObject(obj: REManagedObject): REManagedObject {
  return obj;
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
export const toInt64 = sdk.to_int64;
export const createManagedString = sdk.create_managed_string;
export const createInstance = sdk.create_instance;
export const createManagedArray = sdk.create_managed_array;
export const toFloat = sdk.to_float;
export const floatToPtr = sdk.float_to_ptr;
export const findTypeDefinition = sdk.find_type_definition;

export const reframework = {
  onFrame: re.on_frame,
  onDrawUi: re.on_draw_ui,
  onScriptReset: re.on_script_reset,
  getHookStorage: thread.get_hook_storage,
  getThreadId: thread.get_id,
};

export const relog = log;
export const rejson = json;
export const refFs = fs;
export const imguiApi = imgui;

/** Wall clock, rather than process CPU time, for spawn/post deadlines. */
export function clockSeconds(): number { return os.time(); }

/** @noSelf */
export interface NativeWebconsole {
  steam_snapshot?(): { available: boolean; reason: string; lobbies: {
    id: string; owner: string; self: string; plan: string;
    members: { id: string; ack: string }[] }[] };
  steam_plan?(lobby: string, value: string): boolean;
  steam_ack?(lobby: string, value: string): boolean;
  steam_digest?(value: string): string;
  ping(text: string): string;
  epoch(): number;
  session_id?(): string;
  take_commands(limit: number): string[];
  publish_state(json: string): void;
  publish_results(json: string): void;
}
declare function require(this: void, name: string): unknown;
export function loadWebconsole(): NativeWebconsole {
  return require("webconsole") as NativeWebconsole;
}
