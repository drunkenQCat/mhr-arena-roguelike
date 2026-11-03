import { beforeEach, expect, it, vi } from "vitest";
import { entryHostTestScope } from "./entry_host_scope";
const state = vi.hoisted(() => ({ id: 900103, count: 1, host: 0 as number | null, self: 0 as number | null }));
vi.mock("./sdk", () => ({
  questManager: () => ({ call: () => state.id }),
  getSingleton: () => ({ call: (name: string) => {
    if (name === "getQuestPlayerCount") return state.count;
    const index = name === "getHostIndex" ? state.host : state.self;
    return { get_field: (field: string) => field === "_HasValue" ? index !== null : index };
  } }),
}));
beforeEach(() => Object.assign(state, { id: 900103, count: 1, host: 0, self: 0 }));
it("allows only the real single host of the entry quest", () => {
  expect(entryHostTestScope()).toBe(true);
  state.self = 1; expect(entryHostTestScope()).toBe(false);
  state.self = 0; state.count = 2; expect(entryHostTestScope()).toBe(false);
  state.count = 1; state.id = 900102; expect(entryHostTestScope()).toBe(false);
  state.id = 900103; state.host = null; expect(entryHostTestScope()).toBe(false);
});
