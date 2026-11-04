import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateConfig } from "./config";
import { RunCore } from "./run_core";
import { RunSession, type DeathReading, type RuntimeReading, type SessionPort } from "./run_session";
import { makeQuestPlan, type MonsterCatalog, type QuestPlan } from "./quest_plan";

const catalog: MonsterCatalog = JSON.parse(readFileSync(new URL("../../data/monster_ids.json", import.meta.url), "utf8"));
class FakeGame implements SessionPort {
  reading: RuntimeReading = { time: 0, quest: null, players: [{ id: 0, position: { x: 10, y: 20, z: 30 } }],
    enemies: [], deaths: 0, online: false, canPost: true };
  publications: { plan: QuestPlan; inPlace: boolean }[] = [];
  policies: { plan: QuestPlan | null; hold: boolean }[] = [];
  posts: number[] = [];
  finishes: boolean[] = [];
  events: { event: string; detail: unknown }[] = [];
  pendingDeaths: DeathReading[] = [];
  error: string | null = null;
  ready(): boolean { return true; }
  read(): RuntimeReading { return this.reading; }
  publish(plan: QuestPlan, inPlace: boolean): void { this.publications.push({ plan, inPlace }); }
  policy(plan: QuestPlan | null, hold: boolean): void { this.policies.push({ plan, hold }); }
  post(id: number): void { this.posts.push(id); }
  cancelPost(): void { this.error = null; }
  postingError(): string | null { return this.error; }
  finish(failed: boolean): void {
    this.finishes.push(failed);
    if (this.reading.quest) { this.reading.quest.playing = false; this.reading.quest.status = failed ? "failed" : "success"; }
  }
  takeDeaths(): DeathReading[] { const events = this.pendingDeaths; this.pendingDeaths = []; return events; }
  report(event: string, detail: unknown): void { this.events.push({ event, detail }); }
}

function setup(route: "reentry" | "inPlace" = "reentry") {
  const config = validateConfig(JSON.parse(readFileSync(new URL("../../data/rogue_config.json", import.meta.url), "utf8")));
  config.runtime = { ...config.runtime!, route, carveSeconds: 2, campDwellSeconds: 1,
    spawnTimeoutSeconds: 5, postTimeoutSeconds: 20 };
  const core = new RunCore(config, 42);
  const game = new FakeGame();
  const session = new RunSession(core, catalog, game);
  const tick = (seconds = 1) => { game.reading.time += seconds; session.tick(); };
  const start = (spike = false) => {
    expect(session.start(config.armorOptions[0]!, spike).ok).toBe(true);
    if (!spike) expect(session.choose(core.state.currentChoices.find((o) => o.monsters.length === 2)!.index).ok).toBe(true);
  };
  const enter = (unique = 1) => {
    game.reading.quest = { id: config.quest.id, unique, status: "play", playing: true };
    game.reading.canPost = false;
    game.reading.deaths = 0;
    game.reading.enemies = [];
    tick();
  };
  const clear = () => {
    game.reading.enemies = session.plan!.monsterIds.map((typeId, i) => ({ uid: i + 100, typeId, dead: true, captured: false }));
    tick();
  };
  const village = () => {
    game.reading.quest = null; game.reading.canPost = true; game.reading.enemies = []; tick();
  };
  return { config, core, game, session, tick, start, enter, clear, village };
}

it("adopts a posted entry without startup isolation, clears and shops in place, then releases on lost authorization", () => {
  const { config, core, game, session, tick } = setup("inPlace");
  config.quest.id = 900103;
  let authorized = true;
  Object.assign(game, { allowEntryHostTest: () => authorized });
  game.reading.online = true;
  game.reading.canPost = false;
  game.reading.quest = { id: 900103, unique: 44, playing: false, status: "ready" };
  const wave = { index: 0, typeTag: "entry", label: "host", mode: "single" as const,
    monsters: ["Great Izuchi"], tier: "weak" as const, hpMul: 1, dmgMul: 1, rewardMul: 1, rewardPt: 80 };
  const plan = makeQuestPlan(config, catalog, wave, 1, 1, false);
  expect(session.adoptPostedEntry(plan).ok).toBe(true);
  expect(session.stage).toBe("AwaitQuest");
  expect(game.posts).toEqual([]);
  expect(session.startupStatus.restorePending).toBe(false);
  game.reading.quest.playing = true; game.reading.quest.status = "play";
  tick(); expect(session.stage).toBe("Combat");
  game.reading.enemies = [{ uid: 100, typeId: plan.monsterIds[0]!, dead: true, captured: false }];
  tick(); expect(session.stage).toBe("Carve");
  tick(3); tick(2);
  expect(session.stage).toBe("Selecting");
  expect(session.canShop()).toBe(true);
  expect(session.shopQuest()).toEqual({ questId: 900103, questUnique: 44, entryHostTest: true });
  expect(core.state.wallet.pt).toBe(config.startPt + 80);
  expect(session.choose(0).ok).toBe(true);
  expect(game.publications.at(-1)?.inPlace).toBe(true);
  authorized = false; tick();
  expect(session.stage).toBe("Fault");
  expect(game.policies.at(-1)?.hold).toBe(false);
});

describe("real-event session", () => {
  it("samples idle position changes with the same clock gate used for progression", () => {
    const { session, game, tick } = setup();
    let reads = 0;
    game.read = () => { reads++; return game.reading; };
    Object.assign(game, { now: () => game.reading.time });
    tick(); expect(reads).toBe(1);
    session.tick(); session.tick(); expect(reads).toBe(1);
    game.reading.players[0]!.position.x = 75;
    tick(); expect(session.readingSnapshot!.players[0]!.position.x).toBe(75);
    expect(reads).toBe(2);
  });

  it("does not capture an uninitialised origin as camp and reports a bounded entry failure", () => {
    const { session, game, tick, start, config } = setup();
    start();
    game.reading.quest = { id: config.quest.id, unique: 7, playing: true, status: "play" };
    game.reading.players[0]!.position = { x: 0, y: 0, z: 0 };
    tick(); expect(session.stage).toBe("AwaitQuest"); expect(session.preparation().camp).toBe(null);
    tick(21); expect(session.stage).toBe("Fault"); expect(session.message).toContain("位置");
  });

  it("waits for every expected monster across empty spawn gaps and rewards exactly once", () => {
    const { core, game, session, tick, start, enter } = setup();
    start(true); enter();
    const [first, second] = session.plan!.monsterIds;
    tick();
    expect(core.state.phase).toBe("Combat");
    expect(core.state.wallet.pt).toBe(150);
    game.reading.enemies = [{ uid: 1, typeId: first!, dead: true, captured: false }]; tick();
    game.reading.enemies = []; tick(2);
    expect(core.state.phase).toBe("Combat");
    game.reading.enemies = [{ uid: 2, typeId: second!, dead: false, captured: false }]; tick();
    expect(game.events.find((e) => e.event === "sequential-spawn")?.detail).toMatchObject({ withinTenSeconds: true });
    game.reading.enemies[0]!.dead = true; tick();
    expect(session.stage).toBe("Carve");
    tick();
    expect(game.events.filter((e) => e.event === "wave-cleared")).toHaveLength(1);
    expect(core.state.wallet.pt).toBe(150); // spike has zero reward
  });

  it("requires distinct identities for duplicate-species waves and ignores unrelated monsters", () => {
    const { core, game, session, tick, enter } = setup();
    session.start(core.config.armorOptions[0]!);
    core.state.currentChoices[0]!.monsters = ["Great Izuchi", "Great Izuchi"];
    session.choose(0); enter();
    const id = catalog["Great Izuchi"]!.id;
    game.reading.enemies = [{ uid: 1, typeId: id, dead: true, captured: false },
      { uid: 99, typeId: catalog.Arzuros!.id, dead: true, captured: false }]; tick(); tick();
    expect(session.stage).toBe("Combat");
    game.pendingDeaths = [{ uid: 2, typeId: id, kind: "capture" }]; tick();
    expect(session.stage).toBe("Carve");
  });

  it("reports a live unexpected bear instead of claiming the arena/clear passed", () => {
    const { core, game, session, tick, start, enter } = setup();
    start(true); enter();
    game.reading.enemies = [{ uid: 50, typeId: catalog.Arzuros!.id, dead: false, captured: false }];
    tick();
    expect(session.stage).toBe("Fault");
    expect(core.state.wallet.pt).toBe(150);
    expect(game.events.find((event) => event.event === "unexpected-monster")?.detail).toMatchObject({ typeId: 60 });
  });

  it("keeps PT and spent carts across native returns, then publishes the next layer", () => {
    const { core, game, session, tick, start, enter, clear, village } = setup();
    start(); enter();
    game.reading.deaths = 1; tick();
    const reward = session.plan!.wave.rewardPt;
    clear(); tick(2); tick();
    expect(session.stage).toBe("Returning");
    expect(game.finishes).toEqual([false]);
    expect(core.state.wallet.pt).toBe(150 + reward);
    village();
    expect(session.stage).toBe("Selecting");
    expect(core.state.layer).toBe(2);
    session.choose(0); enter(2);
    expect(core.state.cartsLeft).toBe(2);
    expect(game.publications[1]!.plan.layer).toBe(2);
    expect(game.posts).toHaveLength(2);
  });

  it("waits for carving, all captured player IDs, distance and dwell time", () => {
    const { core, game, session, tick, enter, clear } = setup();
    game.reading.players.push({ id: 1, position: { x: 12, y: 20, z: 30 } });
    session.start(core.config.armorOptions[0]!); session.choose(0); enter(); clear();
    game.reading.players[1]!.position.x = 100; tick(3);
    expect(session.stage).toBe("Carve");
    game.reading.players.pop(); tick();
    expect(session.stage).toBe("Carve");
    game.reading.players.push({ id: 1, position: { x: 12, y: 20, z: 30 } }); tick();
    expect(session.stage).toBe("Carve");
    tick(); expect(session.stage).toBe("Returning");
  });

  it("never interprets a spawn timeout as a clear", () => {
    const { core, game, session, tick, start, enter } = setup();
    start(true); enter(); tick(6);
    expect(session.stage).toBe("Fault");
    expect(core.state.wallet.pt).toBe(150);
    expect(game.policies.at(-1)).toEqual({ plan: null, hold: false });
  });

  it("retries a failed native sequence as a simultaneous layer without PT", () => {
    const { core, game, session, tick, start, enter, village } = setup();
    start(); enter(); tick(6);
    expect(session.stage).toBe("Returning");
    expect(session.plan!.sequential).toBe(false);
    expect(core.state.wallet.pt).toBe(150);
    village();
    expect(session.stage).toBe("AwaitQuest");
    expect(game.publications.at(-1)!.plan.sequential).toBe(false);
    enter(2); tick(6);
    expect(session.stage).toBe("Fault"); // one fallback, not an infinite success/retry loop
  });

  it("falls back from in-place no-go to reentry without awarding the unspawned wave", () => {
    const { core, game, session, tick, start, enter, clear, village } = setup("inPlace");
    start(); enter(); clear(); tick(2); tick();
    expect(session.stage).toBe("Selecting");
    const wallet = core.state.wallet.pt;
    session.choose(0);
    expect(game.publications.at(-1)!.inPlace).toBe(true);
    tick(6);
    expect(session.stage).toBe("Returning");
    expect(session.route).toBe("reentry");
    expect(core.state.wallet.pt).toBe(wallet);
    village();
    expect(session.stage).toBe("AwaitQuest");
    expect(game.publications.at(-1)!.inPlace).toBe(false);
    expect(core.state.layer).toBe(2);
  });

  it("ignores old corpses when replacing a table in place", () => {
    const { core, game, session, tick, start, enter, clear } = setup("inPlace");
    start(); enter(); clear(); tick(2); tick();
    core.state.currentChoices[0]!.monsters = session.plan!.wave.monsters.slice();
    session.choose(0); tick();
    expect(session.stage).toBe("Combat");
    expect(game.events.filter((e) => e.event === "wave-cleared")).toHaveLength(1);
  });

  it("does not misreport a silent non-playing in-place attempt as settlement before its timeout", () => {
    const { core, game, session, tick, start, enter, clear } = setup("inPlace");
    start(); enter(); clear(); tick(2); tick();
    const pt = core.state.wallet.pt;
    session.choose(0);
    game.reading.quest!.playing = false;
    game.reading.quest!.status = "ready";
    tick(); expect(session.stage).toBe("Combat");
    tick(6); expect(session.stage).toBe("Returning");
    expect(session.route).toBe("reentry");
    expect(core.state.wallet.pt).toBe(pt);
    expect(game.events.some((event) => event.event === "in-place-no-go")).toBe(true);
  });

  it("never treats explicit native success as an in-place spawn wait", () => {
    const { game, session, tick, start, enter, clear } = setup("inPlace");
    start(); enter(); clear(); tick(2); tick(); session.choose(0);
    game.reading.quest!.playing = false; game.reading.quest!.status = "success";
    tick(); expect(session.stage).toBe("Fault");
    expect(game.finishes).toEqual([]);
  });

  it("stops on all carts, before a false clear can award PT", () => {
    const { core, game, session, tick, start, enter } = setup();
    start(); enter(); game.reading.deaths = 3; tick();
    expect(core.state.phase).toBe("GameOver");
    expect(session.stage).toBe("Finished");
    expect(core.state.wallet.pt).toBe(150);
    expect(game.finishes).toEqual([true]);
  });

  it("releases policies on foreign quests, online sessions and canceled departure", () => {
    for (const situation of ["foreign", "online", "left"] as const) {
      const { core, game, session, tick, start, enter } = setup();
      start(); enter();
      if (situation === "foreign") game.reading.quest!.id = 101;
      else if (situation === "online") game.reading.online = true;
      else game.reading.quest = null;
      tick();
      expect(session.stage).toBe("Fault");
      expect(core.state.wallet.pt).toBe(150);
      expect(game.policies.at(-1)).toEqual({ plan: null, hold: false });
      expect(game.finishes).toEqual([]);
    }
  });

  it("can retry a failed native post without starting/resetting a run", () => {
    const { core, game, session, tick, start } = setup();
    start(); game.error = "counter routine failed"; tick();
    expect(session.stage).toBe("Fault");
    expect(session.retryPost().ok).toBe(true);
    expect(session.stage).toBe("AwaitQuest");
    expect(core.state.wallet.pt).toBe(150);
    expect(game.posts).toHaveLength(2);
  });
});

it("offers an arena shop identity only after clearing and gathering, never during combat", () => {
 const { session, start, enter, clear, tick } = setup("inPlace");
 start(); expect(session.shopQuest()).toBeUndefined(); enter(42);
 expect(session.shopQuest()).toBeUndefined(); clear(); tick(2); tick();
 expect(session.shopQuest()).toEqual({ questId: 900102, questUnique: 42 });
 session.choose(0); expect(session.shopQuest()).toBeUndefined();
});

describe("M3.5 startup equip lifecycle", () => {
  class StartupGame extends FakeGame {
    prepares: string[] = [];
    restores = 0;
    failPrepare = false;
    startupPrepare(armor: string): { ok: boolean; reason?: string; notice?: string } {
      if (this.failPrepare) return { ok: false, reason: "套装缺失" };
      this.prepares.push(armor);
      return { ok: true };
    }
    startupRestore(): { ok: boolean; reason?: string } {
      this.restores++;
      return { ok: true };
    }
  }

  function setupStartup(route: "reentry" | "inPlace" = "inPlace") {
    const config = validateConfig(JSON.parse(readFileSync(new URL("../../data/rogue_config.json", import.meta.url), "utf8")));
    config.runtime = { ...config.runtime!, route, carveSeconds: 2, campDwellSeconds: 1,
      spawnTimeoutSeconds: 5, postTimeoutSeconds: 20 };
    const core = new RunCore(config, 42);
    const game = new StartupGame();
    const session = new RunSession(core, catalog, game);
    const tick = (seconds = 1) => { game.reading.time += seconds; session.tick(); };
    return { config, core, game, session, tick };
  }

  it("prepares before the run starts and never restores during an active run", () => {
    const { core, game, session, tick } = setupStartup();
    expect(session.start(core.config.armorOptions[0]!).ok).toBe(true);
    expect(game.prepares).toEqual([core.config.armorOptions[0]!]);
    // 任务中：不恢复
    game.reading.quest = { id: core.config.quest.id, unique: 7, playing: true, status: "play" };
    game.reading.canPost = false;
    tick();
    expect(game.restores).toBe(0);
    // inPlace 首波前 Selecting 也在村庄（quest 未接）：绝不能提前恢复
    game.reading.quest = null;
    game.reading.canPost = true;
    tick();
    expect(game.restores).toBe(0);
    // 终局/停止后回到村庄：恢复一次且只一次
    session.stop();
    tick();
    expect(game.restores).toBe(1);
    tick();
    expect(game.restores).toBe(1);
  });

  it("aborts the start when prepare fails and leaves the run untouched", () => {
    const { core, game, session } = setupStartup();
    game.failPrepare = true;
    const result = session.start(core.config.armorOptions[0]!);
    expect(result.ok).toBe(false);
    expect(game.prepares).toHaveLength(0);
    expect(core.state.phase).toBe("Idle");
    expect(session.stage).toBe("Idle");
  });

  it("stop() arms the deferred restore; script reload can re-arm it", () => {
    const { game, session, tick } = setupStartup();
    expect(session.start("骨套（均衡）").ok).toBe(true);
    session.stop();
    game.reading.quest = null;
    game.reading.canPost = true;
    tick();
    expect(game.restores).toBe(1);
    session.armStartupRestore();
    tick();
    expect(game.restores).toBe(2);
  });

  it("village idle session with no prepare history never fires restore", () => {
    const { game, session, tick } = setupStartup();
    tick();
    expect(game.restores).toBe(0);
  });

  it("prepare failure reason propagates to the caller message", () => {
    const { core, session } = setupStartup();
    const game = session as unknown as { port: StartupGame };
    game.port.failPrepare = true;
    const result = session.start(core.config.armorOptions[0]!);
    expect(result.message).toBe("套装缺失");
  });
});

describe("M3.5 test-layer seam", () => {
  class LayerGame extends FakeGame {
    startupPrepare(armor: string) { return { ok: true }; }
  }
  function setupLayer() {
    const config = validateConfig(JSON.parse(readFileSync(new URL("../../data/rogue_config.json", import.meta.url), "utf8")));
    config.runtime = { ...config.runtime!, route: "inPlace", carveSeconds: 2, campDwellSeconds: 1,
      spawnTimeoutSeconds: 5, postTimeoutSeconds: 20 };
    const core = new RunCore(config, 42);
    const game = new LayerGame();
    const session = new RunSession(core, catalog, game);
    return { core, session };
  }

  it("start(testLayer) 跳层后生成 ultimate 单怪 AU 波", () => {
    const { core, session } = setupLayer();
    expect(session.start("骨套（均衡）", false, 16).ok).toBe(true);
    expect(core.state.layer).toBe(16);
    expect(session.stage).toBe("Selecting");
    const choices = core.state.currentChoices;
    expect(choices.length).toBeGreaterThan(0);
    for (const c of choices) {
      expect(c.tier).toBe("ultimate");
      expect(c.typeTag).toBe("极强怪单怪");
      expect(c.rewardMul).toBeCloseTo(1.7, 5);
    }
    // 怪物都在 ultimate 池且 id 为正
    const catalog = JSON.parse(readFileSync(new URL("../../data/monster_ids.json", import.meta.url), "utf8")) as
      Record<string, { id: number; cn?: string }>;
    const byCn = new Map(Object.entries(catalog).map(([en, v]) => [v.cn ?? en, v]));
    for (const c of choices) for (const m of c.monsters) {
      expect(byCn.get(m)).toBeDefined();
      expect(byCn.get(m)!.id).toBeGreaterThan(0);
    }
  });

  it("testLayer 非法值拒绝开局", () => {
    const { session } = setupLayer();
    const r = session.start("骨套（均衡）", false, 0);
    expect(r.ok).toBe(false);
  });
});

describe("M3.5 ultimate kill drop", () => {
  class DropGame extends FakeGame {
    startupPrepare(armor: string) { return { ok: true }; }
    drops = 0;
    ultimateDrop() { this.drops++; return { ok: true, name: "骨制S腰甲" }; }
  }
  function setupDrop(layer: number) {
    const config = validateConfig(JSON.parse(readFileSync(new URL("../../data/rogue_config.json", import.meta.url), "utf8")));
    config.runtime = { ...config.runtime!, route: "inPlace", carveSeconds: 2, campDwellSeconds: 1,
      spawnTimeoutSeconds: 5, postTimeoutSeconds: 20 };
    const core = new RunCore(config, 42);
    const game = new DropGame();
    const session = new RunSession(core, catalog, game);
    const tick = (seconds = 1) => { game.reading.time += seconds; session.tick(); };
    expect(session.start("骨套（均衡）", false, layer).ok).toBe(true);
    const c = core.state.currentChoices[0]!;
    expect(session.choose(c.index).ok).toBe(true);
    game.reading.quest = { id: config.quest.id, unique: 9, playing: true, status: "play" };
    game.reading.canPost = false;
    tick();
    return { core, game, session, tick };
  }

  it("ultimate 波清波触发一次顶级抽取掉落", () => {
    const { core, game, session, tick } = setupDrop(16);
    const ptBefore = core.state.wallet.pt;
    game.reading.enemies = session.plan!.monsterIds.map((typeId, i) => ({ uid: i + 100, typeId, dead: true, captured: false }));
    tick();
    expect(session.stage).toBe("Carve");
    expect(game.drops).toBe(1);
    expect(core.state.killedUltimates).toEqual(session.plan!.wave.monsters);
    const dropEvent = game.events.find((e) => e.event === "ultimate-drop");
    expect(dropEvent).toBeDefined();
    expect((dropEvent!.detail as { name: string }).name).toBe("骨制S腰甲");
    expect(core.state.wallet.pt).toBeGreaterThan(ptBefore);
    // 继续读条/集结阶段不再触发第二次
    tick(2); tick();
    expect(game.drops).toBe(1);
  });

  it("非 ultimate 波清波不掉落", () => {
    const { core, game, session, tick } = setupDrop(1);
    game.reading.enemies = session.plan!.monsterIds.map((typeId, i) => ({ uid: i + 100, typeId, dead: true, captured: false }));
    tick();
    expect(session.stage).toBe("Carve");
    expect(game.drops).toBe(0);
    expect(game.events.find((e) => e.event === "ultimate-drop")).toBeUndefined();
  });
});

it("waits for native load completion and the running quest clock before recording camp", () => {
  const { game, session, start, enter, tick } = setup("inPlace");
  start();
  game.reading.entryReady = false;
  game.reading.players = [{id:0, position:{x:-1498,y:-0.2,z:-1465}}];
  enter();
  expect(session.stage).toBe("AwaitQuest");
  expect(session.campSnapshot).toBeNull();
  game.reading.players = [{id:0, position:{x:0.1,y:50,z:47}}];
  game.reading.entryReady = true; tick();
  expect(session.stage).toBe("Combat");
  expect(session.campSnapshot).toEqual({x:0.1,y:50,z:47});
});
