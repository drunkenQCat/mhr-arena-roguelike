import { beforeEach, expect, it, vi } from "vitest";
const host = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("./sdk", () => ({ getSingleton: () => host, relog: { error: vi.fn() } }));
import { restoreNativeCart } from "./native_cart";
beforeEach(() => host.call.mockReset());
it("marks a failed readback after writing uncertain", () => {
  host.call.mockReturnValueOnce(2).mockReturnValueOnce(undefined).mockImplementationOnce(() => { throw new Error("read failed"); });
  expect(restoreNativeCart()).toMatchObject({ ok: false, uncertain: true });
  expect(host.call).toHaveBeenNthCalledWith(2, "setDeathNum", 1);
});
it("allows rollback when readback proves the count unchanged", () => {
  host.call.mockReturnValueOnce(2).mockReturnValueOnce(undefined).mockReturnValueOnce(2);
  expect(restoreNativeCart()).toMatchObject({ ok: false, uncertain: false });
});
it("confirms the decremented counter", () => {
  host.call.mockReturnValueOnce(2).mockReturnValueOnce(undefined).mockReturnValueOnce(1);
  expect(restoreNativeCart()).toMatchObject({ ok: true, before: 2, after: 1 });
});
