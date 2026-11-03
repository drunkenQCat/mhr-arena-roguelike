import { beforeEach, expect, it, vi } from "vitest";
import { multiplayerScope } from "./multiplayer_scope";
const m=vi.hoisted(()=>({id:900103,count:2,role:"host"}));
vi.mock("./sdk",()=>({questManager:()=>({call:()=>m.id}),getSingleton:()=>({call:()=>m.count})}));
vi.mock("./multiplayer_entry",()=>({readLobbyIdentity:()=>({role:m.role})}));
beforeEach(()=>{m.id=900103;m.count=2;m.role="host";});
it("accepts native host/guest roles and 1–4 loaded quest members, never unrelated or offline contexts",()=>{
 expect(multiplayerScope("host")).toBe(true);expect(multiplayerScope("guest")).toBe(false);
 m.role="guest";m.count=4;expect(multiplayerScope("guest")).toBe(true);
 for(const count of [0,5,NaN]){m.count=count;expect(multiplayerScope()).toBe(false);}
 m.count=2;m.id=900102;expect(multiplayerScope()).toBe(false);
 m.id=900103;m.role="offline";expect(multiplayerScope()).toBe(false);
});
