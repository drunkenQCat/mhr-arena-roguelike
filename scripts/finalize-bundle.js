// TSTL emits a trailing space on bundle module headers. Keep committed builds reproducible.
const fs = require("node:fs");
const path = require("node:path");
const file = path.resolve(__dirname, "../reframework/autorun/mhw_rogue.lua");
const source = fs.readFileSync(file, "utf8");
fs.writeFileSync(file, source.replace(/^(\["[^"\r\n]+"\] = function\(\.\.\.\)) +$/gm, "$1"));
