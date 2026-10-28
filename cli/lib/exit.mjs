// CLI exit codes. Fixed here and in docs/cli.md; tests assert the numbers.
export const EXIT = {
  OK: 0,
  ERROR: 1,
  USAGE: 2,
  UNAVAILABLE: 3,
  REJECTED: 4,
  TIMEOUT: 5,
  UNCERTAIN: 6,
};

export class CliError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.detail = detail;
  }
}

export const usage = (message, detail) => new CliError(EXIT.USAGE, message, detail);
export const unavailable = (message, detail) => new CliError(EXIT.UNAVAILABLE, message, detail);
export const rejected = (message, detail) => new CliError(EXIT.REJECTED, message, detail);
export const timeout = (message, detail) => new CliError(EXIT.TIMEOUT, message, detail);
export const uncertain = (message, detail) => new CliError(EXIT.UNCERTAIN, message, detail);