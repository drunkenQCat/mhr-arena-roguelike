// Shared output contract: stdout carries the result (or one JSON document),
// stderr carries progress and diagnostics. --json switches stdout to compact JSON.
import { CliError, EXIT } from "./exit.mjs";

export function createOutput({ json = false, quiet = false } = {}) {
  return {
    json,
    progress(message) { if (!quiet) process.stderr.write(`${message}\n`); },
    result(value, render) {
      if (json) { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); return; }
      const text = render ? render(value) : JSON.stringify(value, null, 2);
      process.stdout.write(`${text}\n`);
    },
  };
}

/** Runs `fn` and maps thrown CliError/generic errors to exit codes without fake success. */
export async function runMain(fn, output) {
  try {
    return (await fn()) ?? EXIT.OK;
  } catch (error) {
    if (error instanceof CliError) {
      output?.progress(`失败(${error.code}): ${error.message}`);
      if (output?.json) {
        process.stdout.write(`${JSON.stringify({ ok: false, exitCode: error.code,
          error: error.message, detail: error.detail }, null, 2)}\n`);
      }
      return error.code;
    }
    output?.progress(`内部错误: ${error?.stack ?? error}`);
    if (output?.json) {
      process.stdout.write(`${JSON.stringify({ ok: false, exitCode: EXIT.ERROR,
        error: String(error?.message ?? error) }, null, 2)}\n`);
    }
    return EXIT.ERROR;
  }
}