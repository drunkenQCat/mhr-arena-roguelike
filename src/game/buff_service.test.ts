import { beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ values: {} as Record<string, number>, hook: null as any, data: null as any, pre: null as any, storage: {} as Record<string, unknown>, method: "" }));
vi.mock("./sdk", () => ({
  getSingleton: () => ({call: () => ({call: () => h.data, get_address: () => 100})}),
  reframework: {getHookStorage: () => h.storage},
  findTypeDefinition: () => ({get_method: (name:string) => ({name})}),
  hookMethod: (m: any, _pre: any, post: any) => { h.method=m.name;h.hook = post; h.pre = _pre; },
  // Match sol2's void* conversion: Lua numbers are not pointer userdata.
  toInt64: (v: number | {ptr:number}) => typeof v === "number" ? 0 : v.ptr,
  toPtr: (v: number) => ({ptr:v}),
  toManagedObject: (v: {object:unknown}) => v.object,
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
  h.values = {_AtkUpAlive: 7, _DefUpAlive: 3}; h.hook = null; h.storage = {}; h.pre = null;
  h.data = {get_field: (n: string) => h.values[n], set_field: (n: string,v: number) => {h.values[n] = v;}};
});
const service = () => new BuffService({atk: 10, def: 15, crit: 10});
const ptr = (value:number) => ({ptr:value});
function hit(rate:number, flags=4) {
  const fields:Record<string,number>={"<CriticalRate>k__BackingField":rate,_PlayerAttackAttr:flags};
  return {fields,get_field:(name:string)=>fields[name],set_field:(name:string,value:number)=>{fields[name]=value;}};
}
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
it("adjusts each freshly calculated local attack, leaving remote and fixed damage untouched", () => {
  const b=service(); b.addPending("buff_crit"); b.addPending("buff_crit"); b.tick(reading(),scope());
  expect(h.method).toBe("calcCriticalRate"); // the native caller inlines getAdjustCriticalRate
  expect(b.diagnostic().nativeCritical).toBeNull();
  const attack=hit(30);const retval=ptr(0);
  h.pre({2:ptr(100),3:{object:attack}});expect(h.hook(retval)).toBe(retval);
  expect(attack.fields["<CriticalRate>k__BackingField"]).toBe(50);
  // The engine overwrites this runtime field before every post hook.
  attack.fields["<CriticalRate>k__BackingField"]=30;
  h.pre({2:ptr(100),3:{object:attack}});h.hook(retval);
  expect(attack.fields["<CriticalRate>k__BackingField"]).toBe(50);
  expect(b.diagnostic().nativeCritical).toEqual({base:30,result:50});
  const remote=hit(30);h.pre({2:ptr(200),3:{object:remote}});h.hook(retval);
  expect(remote.fields["<CriticalRate>k__BackingField"]).toBe(30);
  const fixed=hit(30,0);h.pre({2:ptr(100),3:{object:fixed}});h.hook(retval);
  expect(fixed.fields["<CriticalRate>k__BackingField"]).toBe(30);
  const negative=hit(-15);h.pre({2:ptr(100),3:{object:negative}});h.hook(retval);
  expect(negative.fields["<CriticalRate>k__BackingField"]).toBe(5);
  b.tick(reading(),scope("Carve"));h.pre({2:ptr(100),3:{object:remote}});h.hook(retval);
  expect(remote.fields["<CriticalRate>k__BackingField"]).toBe(30);
  expect(b.diagnostic().nativeCritical).toBeNull();
});
it("canceled preparation drops pending purchases and unrelated/online quests get no buff", () => {
  const b=service(); b.addPending("buff_atk"); b.tick(null,scope("Finished")); b.tick(reading(),scope());
  expect(h.values._AtkUpAlive).toBe(7);
  b.addPending("buff_atk"); b.tick({...reading(),online:true},scope()); expect(b.snapshot().atk).toBe(0);
});

it("applies personal attack/defense in an authorized multiplayer scope and restores on exit",()=>{
 const b=service(); b.addPending("buff_atk");const r={...reading(),online:true};
 b.tick(r,{...scope(),multiplayer:true});expect(b.diagnostic().active.atk).toBeGreaterThan(0);
 b.tick(r,{...scope("Fault"),multiplayer:true});expect(b.diagnostic().active.atk).toBe(0);
});

it("freezes new-run amounts, restores old stats and reuses the critical-rate hook",()=>{
 const b=service();b.addPending("buff_atk");b.addPending("buff_crit");b.tick(reading(),scope());
 const hook=h.hook;expect(h.values._AtkUpAlive).toBe(17);
 const amounts={atk:23,def:34,crit:45};b.configure(amounts);amounts.crit=999;
 expect(h.values._AtkUpAlive).toBe(7);expect(b.snapshot()).toEqual({atk:0,def:0,crit:0});
 b.addPending("buff_atk");b.addPending("buff_crit");b.tick(reading(43),scope());
 expect(h.values._AtkUpAlive).toBe(30);expect(h.hook).toBe(hook);
 const attack=hit(5);h.pre({2:ptr(100),3:{object:attack}});h.hook(ptr(0));
 expect(attack.fields["<CriticalRate>k__BackingField"]).toBe(50);
});
