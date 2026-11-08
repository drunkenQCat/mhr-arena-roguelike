import { beforeEach, expect, it, vi } from "vitest";
import { InplaceWaves } from "./inplace_waves";
import type { QuestPlan } from "../core/quest_plan";
const api = vi.hoisted(() => ({ q: vi.fn(), get: vi.fn(), create: vi.fn() }));
vi.mock("./sdk", () => ({ questManager: api.q, getSingleton: api.get, createInstance: api.create }));
function object(fields: Record<string, any> = {}, call = (_: string, ..._args: any[]): any => null): any {
 return { get_field: (n: string) => fields[n], set_field: (n: string, v: any) => { fields[n] = v; }, call, add_ref: vi.fn(), release: vi.fn() };
}
function array(values: any[]): any { return { ...object({}, (n: string, i: number, v: any) => { if (n === "Set") values[i] = v; else return values[i]; }), get_size: () => values.length, get_element: (i: number) => values[i] }; }
function fixture(types = [60]) {
 let online = false, unique = 55, bosses: any[] = [], nextId = 119;
 const sourceFields = { _TypeValue: 98, _BlockNo: 11 };
 const source = object(sourceFields);
 const fields = { _BossSet: array(Array.from({ length: 7 }, () => object({ EmSetId: -1, State: 2 }))), _BossSetNoTbl: array([0, 1, 2, 3, 2, -1, -1]), _ExtraEmRno: 10, _BossSetCount: 5, _BossSetCond: array(Array(7).fill(0)), _BossLoadStartOk: array(Array(7).fill(true)), _BossLoadDone: array(Array(7).fill(1)) };
 const q = object(fields, (n) => n === "isPlayQuest" ? true : n === "get_ActiveQuestNo" ? 900102 : n === "getActiveQuestUniqueNo" ? unique : null);
 const registrations: number[] = [];
 const cleanup: any[] = [];
 const em = object({ _EnemySetInfoList: object({}, () => nextId) }, (n, arg) => {
  if (n === "registerRequestDestroyEnemyList") { cleanup.push(arg); return; }
  if (n === "getBossEnemyCount") return bosses.length;
  if (n === "getBossEnemy") return bosses[arg];
  if (n === "getEnemySetInfo(System.Int32)") return object({}, () => source);
  if (n === "createEnemySetInfo(snow.quest.EnemySetParam)") {
   registrations.push(arg.get_field("_TypeValue")); const id = nextId++;
   return object({}, (name) => name === "get_EmSetId" ? id : name === "get_UniqueId" ? id * 100 : 0);
  }
 });
 api.q.mockReturnValue(q);
 api.get.mockImplementation((n: string) => n === "snow.stage.StageManager" ? object({}, () => online) : em);
 api.create.mockImplementation(() => object({}));
 const report = vi.fn(); const backend = new InplaceWaves(report);
 const plan = { questId: 900102, mapNo: 10, sequential: true, token: 2, monsterIds: types } as QuestPlan;
 return { backend, plan, fields, registrations, report, cleanup, sourceFields, setOnline: () => { online = true; }, changeQuest: () => { unique++; }, setBosses: (v: any[]) => { bosses = v; }, setCount: (v: number) => { nextId = v; } };
}
beforeEach(() => vi.clearAllMocks());
it("rejects online, live actors, and a growing registration list before mutating the scheduler", () => {
 const f = fixture(); f.setOnline(); expect(() => f.backend.prepare(f.plan)).toThrow("owned solo");
 const g = fixture(); g.setBosses([object({}, () => false)]); expect(() => g.backend.prepare(g.plan)).toThrow("still alive");
 const h = fixture(); h.setCount(512); expect(() => h.backend.prepare(h.plan)).toThrow("safety limit");
 expect(api.create).not.toHaveBeenCalled();
});
it("uses a free slot while preserving a corpse slot and the original parameters", () => {
 const f = fixture(); f.setBosses([object({}, (n) => n === "isDieBehaviorActive")]);
 f.fields._BossSet.get_element(2).set_field("EmSetId", 118);
 f.backend.prepare(f.plan); f.backend.tick(1);
 expect(f.registrations).toEqual([60]); expect(f.sourceFields._TypeValue).toBe(98);
 expect(f.fields._BossSetNoTbl.call("Get", 2)).toBe(3); expect(f.fields._BossSetNoTbl.call("Get", 3)).toBe(-1);
 expect(f.fields._BossSetCount).toBe(2); expect(f.fields._ExtraEmRno).toBe(5);
 expect(f.fields._BossSet.get_element(3).get_field("EmType")).toBe(60);
 expect(f.fields._BossSet.get_element(2).get_field("EmSetId")).toBe(118);
});
it("sequential dual waves require death and use another slot while the first corpse remains", () => {
 const f = fixture([60, 54]); f.backend.prepare(f.plan); f.backend.tick(1);
 f.fields._ExtraEmRno = 10;
 f.backend.tick(2); expect(f.registrations).toEqual([60]);
 f.setBosses([object({}, (n) => n === "isDieBehaviorActive")]);
 f.backend.death(11900); f.backend.tick(3);
 expect(f.registrations).toEqual([60, 54]);
 expect(f.fields._BossSet.get_element(2).get_field("EmSetId")).toBe(119);
 expect(f.fields._BossSet.get_element(3).get_field("EmSetId")).toBe(120);
});
it("does not continue a queued wave in a replacement quest or after cancellation", () => {
 const f = fixture(); f.backend.prepare(f.plan); f.changeQuest(); expect(() => f.backend.tick(1)).toThrow("identity changed");
 f.backend.cancel(); f.backend.tick(2); expect(f.registrations).toEqual([]);
});

it("kicks a separate native load for the second simultaneous actor while the first remains alive", () => {
 const f = fixture([60, 54]); f.plan.sequential = false;
 f.backend.prepare(f.plan); f.backend.tick(1);
 expect(f.registrations).toEqual([60]);
 f.fields._ExtraEmRno = 10;
 f.setBosses([object({}, (n) => n === "get_UniqueId" ? 11900 : false)]);
 f.backend.tick(2);
 expect(f.registrations).toEqual([60, 54]);
 expect(f.fields._BossSetNoTbl.call("Get", 2)).toBe(3);
 expect(f.fields._BossSetNoTbl.call("Get", 3)).toBe(-1);
 expect(f.fields._BossSetCond.call("Get", 2)).toBe(1);
 expect(f.fields._BossSetCond.call("Get", 3)).toBe(1);
 expect(f.report).toHaveBeenCalledTimes(2);
});
it("waits before registering when three corpse actors occupy the native actor budget",()=>{
 const f=fixture([60]);const corpse=()=>object({},(n)=>n==="isDieBehaviorActive");
 f.setBosses([corpse(),corpse(),corpse()]);f.backend.prepare(f.plan);f.backend.tick(1);
 expect(f.registrations).toEqual([]);expect(f.backend.waitingForCapacity).toBe(true);
 f.setBosses([corpse(),corpse()]);f.backend.tick(2);expect(f.registrations).toEqual([60]);
});

it("queues old corpses only after every previous actor has been verified ended",()=>{
 const f=fixture();const dead=object({},n=>n==="isDieBehaviorActive");
 f.setBosses([dead,object({},()=>false)]);expect(()=>f.backend.prepare(f.plan)).toThrow("still alive");
 expect(f.cleanup).toEqual([]);
 f.setBosses([dead]);f.backend.prepare(f.plan);expect(f.cleanup).toEqual([dead]);
});

it("stages records without starting native load until every peer acknowledges",()=>{
 const f=fixture(); const staged=vi.fn(); let commit=false;
 f.backend.setSync({role:"host",valid:()=>true,expected:()=>null,staged,activate:()=>commit});
 f.backend.prepare(f.plan);f.backend.tick(1);
 expect(staged).toHaveBeenCalledWith({token:2,ordinal:0,type:60,slot:2,id:119,uid:11900});
 expect(f.fields._ExtraEmRno).toBe(10);f.backend.tick(2);expect(f.fields._ExtraEmRno).toBe(10);
 expect(f.backend.status).toContain("waiting all peers");
 commit=true;f.backend.tick(3);expect(f.fields._ExtraEmRno).toBe(5);expect(f.registrations).toEqual([60]);
 expect(f.backend.status).toBe("inPlace native loader activated: UID 11900; 0 pending");
 f.backend.tick(4);expect(f.backend.status).not.toContain("waiting all peers");
});
it("guests never allocate without a host ticket and stop before loading mismatched identities",()=>{
 const f=fixture();let ticket:any=null;
 f.backend.setSync({role:"guest",valid:()=>true,expected:()=>ticket,staged:vi.fn(),activate:()=>false});
 f.backend.prepare(f.plan);f.backend.tick(1);expect(f.registrations).toEqual([]);
 ticket={token:2,ordinal:0,type:60,slot:3,id:99,uid:9900};
 expect(()=>f.backend.tick(2)).toThrow("identity differs");expect(f.fields._ExtraEmRno).toBe(10);
});
it("guests stage the exact requested slot and activate each ticket once",()=>{
 const f=fixture();const ticket={token:2,ordinal:0,type:60,slot:3,id:119,uid:11900};let commit=false;
 f.backend.setSync({role:"guest",valid:()=>true,expected:()=>ticket,staged:vi.fn(),activate:()=>commit});
 f.backend.prepare(f.plan);f.backend.tick(1);expect(f.fields._BossSetNoTbl.call("Get",2)).toBe(3);
 f.backend.tick(2);expect(f.fields._ExtraEmRno).toBe(10);commit=true;f.backend.tick(3);f.backend.tick(4);
 expect(f.registrations).toEqual([60]);expect(f.fields._ExtraEmRno).toBe(5);
});
