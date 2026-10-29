import { beforeEach, expect, it, vi } from "vitest";
import { NativeRuntime } from "./native_runtime";
import type { QuestInstaller } from "./quest_installer";
import { validateConfig } from "../core/config";
import { defaultConfig } from "./default_config";

const host = vi.hoisted(() => ({ online: false, playing: true, id: 900102, warpMoving: false,
  warp: null as { pos: unknown; rot: unknown; context: unknown } | null, flow: null as number | null,
  calls: vi.fn(), vecField: vi.fn(), vector: {} as Record<string, number> }));
vi.mock("./sdk", () => ({
  clockSeconds: () => 100,
  questManager: () => ({ call: (n: string) => n === "isPlayQuest" ? host.playing : host.id }),
  getSingleton: (n: string) => n === "snow.stage.StageManager" ? { call: (m: string, ...a: unknown[]) => {
      if (m === "get_IsQuestOnline") return host.online;
      if (m === "get_IsWarpFlowMoving") return host.warpMoving;
      if (m === "setPlWarpInfo(via.vec3, System.Single, snow.stage.StageManager.AreaMoveQuest)") {
        host.warp = { pos: a[0], rot: a[1], context: a[2] }; return undefined;
      }
      if (m === "set_CurrentWarpFlow") { host.flow = a[0]; return undefined; }
      return undefined;
    } }
    : n === "snow.player.PlayerManager" ? { call: () => ({
      get_field: () => ({ x: 10, y: 20, z: 30 }),
      get_type_definition: () => ({ get_method: () => ({}) }),
      call: (method: string, ...args: unknown[]) => method === "isAreaMove" ? host.moving : host.calls(method, ...args),
    }) } : null,
  createInstance: () => ({ set_field: (name: string, value: number) => {
    host.vector[name] = value; host.vecField(name, value);
  } }),
}));
beforeEach(() => { host.online = false; host.playing = true; host.id = 900102; host.warpMoving = false;
  host.warp = null; host.flow = null;
  host.calls.mockClear(); host.vecField.mockClear(); host.vector = {};
  (globalThis as unknown as { Vector3f?: unknown }).Vector3f =
    { new: (x: number, y: number, z: number) => ({ x, y, z }) };});
const runtime = () => new NativeRuntime(validateConfig(defaultConfig), {} as QuestInstaller);
it("refuses village, foreign quest and online TP before any position request", () => {
  host.playing = false; expect(() => runtime().teleportPlayer({ x: 1, y: 2, z: 3 })).toThrow("active solo");
  host.playing = true; host.id = 101; expect(() => runtime().teleportPlayer({ x: 1, y: 2, z: 3 })).toThrow("active solo");
  host.id = 900102; host.online = true; expect(() => runtime().teleportPlayer({ x: 1, y: 2, z: 3 })).toThrow("active solo");
  expect(host.calls).not.toHaveBeenCalled();
});
it("rejects nonfinite positions and concurrent warp flows", () => {
  expect(() => runtime().teleportPlayer({ x: NaN, y: 2, z: 3 })).toThrow("invalid position");
  host.warpMoving = true;
  expect(() => runtime().teleportPlayer({ x: 1, y: 2, z: 3 })).toThrow("warp flow already moving");
  expect(host.warp).toBeNull();
});
it("drives the stage warp flow (engine fast-travel path) with a value vec3", () => {
  runtime().teleportPlayer({ x: 1, y: 2, z: 3 });
  expect(host.warp).toEqual({ pos: { x: 1, y: 2, z: 3 }, rot: 0.0, context: 1 });
  expect(host.flow).toBe(0);
});
