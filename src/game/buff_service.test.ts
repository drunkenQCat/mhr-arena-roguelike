import { beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ values: {} as Record<string, number>, hook: null as any, data: null as any }));
vi.mock("./sdk", () => ({
  getSingleton: () => ({call: () => ({call: () => h.data})}),
  findTypeDefinition: () => ({get_method: () => ({})}),
  hookMethod: (_m: any, _pre: any, post: any) => { h.hook = post; },
  toInt64: (v: number) => v, toPtr: (v: number) => v,
  relog: { info: vi.fn(), error: vi.fn() }
}));
import { BuffService } from "./buff_service";
import type { BuffScope } from "./buff_service";
import type { RuntimeReading } from "../core/run_session";
const scope = (stage: BuffScope["stage"] = "Combat", layer = 1): BuffScope => ({stage, layer, questId: 900102});
const reading = (unique = 42, deaths = 0): RuntimeReading => ({time: unique * 100 + deaths,
  quest: {id: 900102, unique, playing: true, status: "play"}, online: false, deaths,
  players: [], enemies: [], canPost: false});
beforeEach(() => {
  h.values = {_AtkUpAlive: 7, _DefUpAlive: 3}; h.hook = null;
  h.data = {get_field: (n: string) => h.values[n], set_field: (n: string,v: number) => {h.values[n] = v;}};
});
const service = () => new BuffService({atk: 10, def: 15, crit: 10});
it("stacks purchases without writing during preparation", () => {
  const b = service(); b.addPending("buff_atk"); expect(b.addPending("buff_atk").total).toBe(20);
  b.tick(reading(),scope("Selecting")); expect(h.values._AtkUpAlive).toBe(7);
  b.tick(reading(),scope()); expect(h.values._AtkUpAlive).toBe(27);
  expect(b.snapshot().atk).toBe(0);
});
it("mixed purchases add to existing native bonuses and clean only our contribution", () => {
  const b=service(); b.addPending("buff_atk"); b.addPending("buff_def"); b.addPending("buff_def");
  b.tick(reading(),scope()); expect(h.values).toEqual({_AtkUpAlive:17,_DefUpAlive:33});
  b.tick(reading(),scope("Carve")); expect(h.values).toEqual({_AtkUpAlive:7,_DefUpAlive:3});
});
it("consumes a buff after one wave even when the inPlace quest identity stays unchanged", () => {
  const b=service(); b.addPending("buff_atk"); b.tick(reading(),scope());
  b.tick(reading(),scope("Carve")); b.tick(reading(),scope("Selecting",2)); b.tick(reading(),scope("Combat",2));
  expect(h.values._AtkUpAlive).toBe(7); expect(b.diagnostic().active.atk).toBe(0);
});
it("new between-wave purchases are consumed by the following wave", () => {
  const b=service(); b.addPending("buff_atk"); b.tick(reading(),scope()); b.tick(reading(),scope("Carve"));
  b.addPending("buff_atk"); b.addPending("buff_atk"); b.tick(reading(),scope("Selecting",2));
  expect(h.values._AtkUpAlive).toBe(7); b.tick(reading(),scope("Combat",2)); expect(h.values._AtkUpAlive).toBe(27);
});
it("native retry preserves the current wave bonus without double addition", () => {
  const b=service(); b.addPending("buff_atk"); b.tick(reading(),scope());
  b.tick(reading(),scope("Returning")); expect(h.values._AtkUpAlive).toBe(7);
  b.tick(reading(43),scope()); expect(h.values._AtkUpAlive).toBe(17);
  b.tick(reading(43),scope()); expect(h.values._AtkUpAlive).toBe(17);
});
it("reapplies after a cart rebuild and clears at shutdown", () => {
  const b=service(); b.addPending("buff_def"); b.tick(reading(),scope());
  h.values._DefUpAlive=0; b.tick(reading(42,1),scope()); expect(h.values._DefUpAlive).toBe(15);
  b.shutdown(); expect(h.values._DefUpAlive).toBe(0);
});
it("does not overwrite a later native potion update on cleanup", () => {
  const b=service(); b.addPending("buff_atk"); b.tick(reading(),scope()); h.values._AtkUpAlive=99;
  b.tick(reading(),scope("Carve")); expect(h.values._AtkUpAlive).toBe(99);
});
it("critical post hook is additive, stable on repeated reads, and handles negative int32 values", () => {
  const b=service(); b.addPending("buff_crit"); b.addPending("buff_crit"); b.tick(reading(),scope());
  expect(h.hook(30)).toBe(50); expect(h.hook(30)).toBe(50);
  expect(h.hook(4294967281)).toBe(5); // -15 + 20
  b.tick(reading(),scope("Carve")); expect(h.hook(30)).toBe(30);
});
it("canceled preparation drops pending purchases and unrelated/online quests get no buff", () => {
  const b=service(); b.addPending("buff_atk"); b.tick(null,scope("Finished")); b.tick(reading(),scope());
  expect(h.values._AtkUpAlive).toBe(7);
  b.addPending("buff_atk"); b.tick({...reading(),online:true},scope()); expect(b.snapshot().atk).toBe(0);
});
