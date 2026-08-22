import type { Logger } from "./types.js";

/** §10 — silent by default; merchants inject their own structured logger. */
export const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

/** Convenience logger for examples and `doctor`. Not used unless opted into. */
export function consoleLogger(prefix = "octroi"): Logger {
  const write =
    (level: "debug" | "info" | "warn" | "error") =>
    (message: string, fields?: Record<string, unknown>) => {
      // eslint-disable-next-line no-console
      console[level](`[${prefix}] ${message}`, fields ?? {});
    };
  return {
    debug: write("debug"),
    info: write("info"),
    warn: write("warn"),
    error: write("error"),
  };
}
