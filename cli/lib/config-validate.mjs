// Reuse the game's own config validator instead of re-implementing the schema.
//
// src/core/config.ts is TypeScript for the Lua runtime, but its checks are plain
// JavaScript. It is compiled on demand with the TypeScript dependency already in
// package.json, resolving relative imports inside src/ to sibling data: URLs, then
// cached in memory. Any toolchain failure is reported as such — never as "valid".
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { CliError, EXIT } from "./exit.mjs";

const require = createRequire(import.meta.url);

// Compiled module URLs with their data: URLs tagged so tests can reload them.
// Declared before the helpers that use it; assigning later would leave the first
// compile call reading an uninitialised binding.
let nonce = 0;

function loadTypeScript(root) {
  try { return require(join(root, "node_modules", "typescript", "lib", "typescript.js")); }
  catch { /* fall through */ }
  try { return require("typescript"); }
  catch {
    throw new CliError(EXIT.UNAVAILABLE,
      "本地校验需要 typescript 依赖（npm install）；可改用 --no-local-validation 交由游戏侧报错。");
  }
}

export function createValidator(root) {
  const ts = loadTypeScript(root);
  const sourceRoot = join(root, "src");
  const compiled = new Map(); // absolute .ts path -> data: URL
  const loaded = new Map();   // data: URL -> module namespace

  function compileTarget(fromFile, spec) {
    const target = resolve(dirname(fromFile), spec);
    return compile(target.endsWith(".ts") ? target : `${target}.ts`);
  }

  function compile(file) {
    const absolute = resolve(file);
    const cached = compiled.get(absolute);
    if (cached) return cached;
    const output = ts.transpileModule(readFileSync(absolute, "utf8"), {
      fileName: absolute,
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        isolatedModules: true,
      },
    }).outputText;
    // TypeScript emits `import { X } from "./mod"` and `import "./mod"`; both
    // specifiers must resolve to sibling data: URLs before Node evaluates this.
    const rewritten = output
      .replace(/(from\s+)(["'])(\.[^"']+)\2/g, (match, head, quote, spec) =>
        `${head}${JSON.stringify(compileTarget(absolute, spec))}`)
      .replace(/(^|\n)\s*import\s+(["'])(\.[^"']+)\2\s*;?/g, (match, head, quote, spec) =>
        `${head}import ${JSON.stringify(compileTarget(absolute, spec))};`);
    const url = `data:text/javascript;base64,${Buffer.from(rewritten).toString("base64")}#v${nonce++}`;
    compiled.set(absolute, url);
    return url;
  }

  async function loadModule(file) {
    const url = compile(file);
    if (!loaded.has(url)) loaded.set(url, await import(url));
    return loaded.get(url);
  }

  return {
    /** Throws CliError(USAGE) on invalid config; returns the normalized config. */
    async validate(raw) {
      let module;
      try {
        module = await loadModule(join(sourceRoot, "core", "config.ts"));
      } catch (error) {
        throw new CliError(EXIT.UNAVAILABLE, `无法加载本地校验器：${error.message}`);
      }
      if (typeof module.validateConfig !== "function") {
        throw new CliError(EXIT.UNAVAILABLE, "src/core/config.ts 未导出 validateConfig");
      }
      try {
        return module.validateConfig(raw);
      } catch (error) {
        throw new CliError(EXIT.USAGE, `配置校验失败：${error.message}`, { cause: error.message });
      }
    },
  };
}