import {expect,it,vi} from "vitest";
import {ConfigRecovery} from "./config_recovery";
const time=vi.hoisted(()=>({now:100}));
vi.mock("./sdk",()=>({clockSeconds:()=>time.now}));
it("does not read or write configuration while native/personal recovery is still active",()=>{
 const recover=vi.fn();const guard=new ConfigRecovery({recover});guard.tick(false);expect(recover).not.toHaveBeenCalled();
});
it("blocks new preparation on failed rollback and retries at most once per second until the lock is gone",()=>{
 time.now=100;const recover=vi.fn().mockImplementationOnce(()=>{throw new Error("file locked");}).mockReturnValue(true);
 const guard=new ConfigRecovery({recover});guard.tick(true);expect(guard.message).toContain("暂不能开新局");
 guard.tick(true);expect(recover).toHaveBeenCalledOnce();time.now++;guard.tick(true);expect(guard.message).toBeNull();expect(recover).toHaveBeenCalledTimes(2);
});
