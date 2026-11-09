import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
const {validateCapabilities,checkSourceProtocols}=createRequire(import.meta.url)("./release-capabilities.js");
const current=()=>JSON.parse(readFileSync(new URL("../data/release_capabilities.json",import.meta.url),"utf8"));
it("keeps release protocols aligned with actual runtime sources",()=>{
 const c=current();expect(()=>validateCapabilities(c)).not.toThrow();expect(()=>checkSourceProtocols(c)).not.toThrow();
 c.protocols.entryRules--;expect(()=>checkSourceProtocols(c)).toThrow("differs from source");
});
it("cannot promote local simulated-Steam evidence to a stable official multiplayer claim",()=>{
 const c=current();c.multiplayer.stable=true;c.releaseStage="multiplayer-stable";
 expect(()=>validateCapabilities(c)).toThrow("unverified gates");
 c.verification.officialSteamCrossPc="verified";c.verification.longRun="verified";
 expect(()=>validateCapabilities(c)).toThrow("unverified gates");
 c.verification.localNativeConfigPlayers=[2,3,4];c.remainingGates=[];
 expect(()=>validateCapabilities(c)).not.toThrow();
});
it.each(["official-steam-cross-pc","config-native-3-4","long-run"])("does not hide the pending %s gate",id=>{
 const c=current();c.remainingGates=c.remainingGates.filter((g:{id:string})=>g.id!==id);
 expect(()=>validateCapabilities(c)).toThrow("hidden");
});
