import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HttpError, postCommand, SubmissionUncertain, waitForReceipt, type ConsoleState } from "./api";

const state = { bridgeId: "current", configVersion: 0, questUnique: 42,
  preparation: { waveToken: 1 } } as ConsoleState;
const receipt = (status = "applied", bridgeId = "current") => ({ bridgeId,
  last: { id: "request-1", status, message: "done" }, history: [] });
const reply = (value: unknown, status = 200) => ({ ok: status >= 200 && status < 300,
  status, json: async () => value });
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it("keeps waiting through a partial JSON read and transient 503, then confirms delivery", async () => {
  fetchMock.mockResolvedValueOnce({ ok: true, json: async () => { throw new SyntaxError("partial JSON"); } })
    .mockResolvedValueOnce(reply({}, 503)).mockResolvedValueOnce(reply(receipt("queued")))
    .mockResolvedValueOnce(reply(receipt()));
  const result = waitForReceipt("request-1", "current", { purchase: true });
  await vi.advanceTimersByTimeAsync(650);
  expect(await result).toMatchObject({ status: "applied" });
  expect(fetchMock).toHaveBeenCalledTimes(4);
  expect(fetchMock.mock.calls.every(([path]) => path === "/api/results")).toBe(true);
});

it("stops immediately when the bridge session changes", async () => {
  fetchMock.mockResolvedValue(reply(receipt("applied", "new-session")));
  await expect(waitForReceipt("request-1", "current")).rejects.toThrow("会话已更换");
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("bounds unreadable receipt retries and reports an unknown result with its request ID", async () => {
  fetchMock.mockResolvedValue(reply({}, 503));
  const result = waitForReceipt("request-1", "current");
  const check = expect(result).rejects.toThrow(/request-1.*不要重复购买/);
  await vi.advanceTimersByTimeAsync(12200); await check;
  expect(fetchMock.mock.calls.every(([path]) => path === "/api/results")).toBe(true);
});

it("does not retry a forbidden response as a transient file read", async () => {
  fetchMock.mockResolvedValue(reply({}, 403));
  await expect(waitForReceipt("request-1", "current")).rejects.toBeInstanceOf(HttpError);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("retains the original request ID when POST acknowledgement is lost, without resending", async () => {
  fetchMock.mockRejectedValueOnce(new TypeError("connection lost after request"));
  let error: unknown;
  try { await postCommand(state, "buy", { itemId: "potion" }); } catch (e) { error = e; }
  expect(error).toBeInstanceOf(SubmissionUncertain);
  const sent = JSON.parse(fetchMock.mock.calls[0]![1].body);
  expect((error as SubmissionUncertain).requestId).toBe(sent.id);
  expect(fetchMock.mock.calls[0]![1].signal).toBeInstanceOf(AbortSignal);
  fetchMock.mockResolvedValue(reply({ bridgeId: "current", last: { id: sent.id, status: "applied" } }));
  expect((await waitForReceipt(sent.id, "current", { purchase: true })).status).toBe("applied");
  expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
});

it("treats HTTP 409 as a definitive slot rejection, rather than an accepted command", async () => {
  fetchMock.mockResolvedValue(reply({ ok: false }, 409));
  await expect(postCommand(state, "buy")).rejects.toMatchObject({ status: 409 });
});

it("submits on LAN HTTP where crypto.randomUUID is unavailable", async () => {
  vi.stubGlobal("crypto", { getRandomValues: (bytes: Uint8Array) => bytes.fill(123) });
  fetchMock.mockResolvedValue(reply({ ok: true, queued: true }));
  expect(await postCommand(state, "getConfig")).toMatch(/^web-[0-9a-f]{32}$/);
});
