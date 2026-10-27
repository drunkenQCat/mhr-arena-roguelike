import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateConfig } from "./config";
import { RunCore } from "./run_core";
import { RunSession, type DeathReading, type RuntimeReading, type SessionPort } from "./run_session";
import type { MonsterCatalog, QuestPlan } from "./quest_plan";

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

describe("real-event session", () => {
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
