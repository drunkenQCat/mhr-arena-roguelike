const fs = require("node:fs");
const path = require("node:path");
const luaparse = require("luaparse");

const projectRoot = path.resolve(__dirname, "..");
const luaRoot = path.join(projectRoot, "reframework");
const luaFiles = [];

function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) walk(fullPath);
        else if (entry.isFile() && entry.name.endsWith(".lua")) luaFiles.push(fullPath);
    }
}

walk(luaRoot);
if (luaFiles.length === 0) {
    console.error(`No Lua files found under ${path.relative(projectRoot, luaRoot)}`);
    process.exit(1);
}

let failed = false;
for (const file of luaFiles) {
    try {
        const source = fs.readFileSync(file, "utf8");
        luaparse.parse(source, { luaVersion: "5.3", locations: true });
        console.log(`PASS ${path.relative(projectRoot, file)}`);
    } catch (error) {
        failed = true;
        console.error(`FAIL ${path.relative(projectRoot, file)}: ${error.message}`);
    }
}

process.exit(failed ? 1 : 0);
