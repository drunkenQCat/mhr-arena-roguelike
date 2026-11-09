// Shared release/UI claims. Validation guards consistency, not proof of gameplay.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const source = path.join(root, "data/release_capabilities.json");
function validateCapabilities(c) {
  const requireClaim = (ok, message) => { if (!ok) throw new Error(`Release capabilities: ${message}`); };
  requireClaim(c?.schemaVersion === 1, "unsupported schema");
  requireClaim(["multiplayer-playtest", "multiplayer-stable"].includes(c.releaseStage), "invalid release stage");
  requireClaim(c.multiplayer?.implemented === true && c.multiplayer.maxPlayers === 4 && typeof c.multiplayer.stable === "boolean", "invalid multiplayer scope");
  for (const key of ["http", "entryRules", "run"]) requireClaim(Number.isInteger(c.protocols?.[key]) && c.protocols[key] > 0, `invalid ${key} protocol`);
  requireClaim(/^\d+\.\d+\.\d+$/.test(c.protocols?.plugin ?? ""), "invalid plugin version");
  const v = c.verification;
  const players = values => Array.isArray(values) && values.length > 0 && values.every((n, i) => [2, 3, 4].includes(n) && (i === 0 || n > values[i - 1]));
  requireClaim(players(v?.localNativeGameplayPlayers) && players(v?.localNativeConfigPlayers), "invalid local native verification counts");
  requireClaim(v.localNativeConfigPlayers.every(n => v.localNativeGameplayPlayers.includes(n)), "config verification exceeds gameplay verification");
  for (const key of ["officialSteamCrossPc", "longRun"]) requireClaim(["pending", "verified"].includes(v[key]), `invalid ${key} verification`);
  requireClaim(typeof v.reference === "string" && v.reference.startsWith("https://github.com/drunkenQCat/"), "missing evidence reference");
  requireClaim([c.playerSummary, c.verificationSummary].every(s => typeof s === "string" && s.length > 0), "missing player explanation");
  requireClaim(Array.isArray(c.remainingGates) && c.remainingGates.every(g => typeof g.id === "string" && typeof g.label === "string" && g.label.length > 0) && new Set(c.remainingGates.map(g => g.id)).size === c.remainingGates.length, "invalid remaining gates");
  const gate = id => c.remainingGates.some(g => g.id === id);
  requireClaim(v.officialSteamCrossPc !== "pending" || gate("official-steam-cross-pc"), "pending official Steam gate is hidden");
  requireClaim(v.longRun !== "pending" || gate("long-run"), "pending long-run gate is hidden");
  requireClaim(v.localNativeConfigPlayers.length === 3 || gate("config-native-3-4"), "pending native config gate is hidden");
  if (c.multiplayer.stable || c.releaseStage === "multiplayer-stable") {
    requireClaim(c.multiplayer.stable && c.releaseStage === "multiplayer-stable" && v.officialSteamCrossPc === "verified" && v.longRun === "verified" && v.localNativeConfigPlayers.length === 3 && c.remainingGates.length === 0, "stable release has unverified gates");
  }
  return c;
}
function checkSourceProtocols(c) {
  const read = file => fs.readFileSync(path.join(root, file), "utf8");
  const match = (file, pattern) => { const m = read(file).match(pattern); if (!m) throw new Error(`Cannot locate protocol in ${file}`); return m[1]; };
  const actual = {
    http: Number(match("src/game/webconsole_bridge.ts", /protocol:\s*(\d+),\s*bridgeId/)),
    entryRules: Number(match("src/game/multiplayer_entry.ts", /runtimeProtocol:\s*(\d+)/)),
    run: Number(match("src/game/multiplayer_run.ts", /interface Frame \{ v:\s*(\d+)/)),
    plugin: match("native/webconsole/src/common.h", /PLUGIN_VERSION\s*=\s*"([^"]+)"/)
  };
  for (const key of Object.keys(actual)) if (c.protocols[key] !== actual[key]) throw new Error(`Release ${key} protocol differs from source (${c.protocols[key]} vs ${actual[key]})`);
}
module.exports = { validateCapabilities, checkSourceProtocols };
if (require.main === module) {
  try {
    const c = validateCapabilities(JSON.parse(fs.readFileSync(process.argv.includes("--stdin") ? 0 : source, "utf8").replace(/^\uFEFF/, "")));
    if (!process.argv.includes("--stdin")) checkSourceProtocols(c);
    process.stdout.write(JSON.stringify(c));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
