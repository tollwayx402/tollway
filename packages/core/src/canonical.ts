import { CanonicalJsonError } from "./errors.js";

/**
 * Deterministic JSON serialization (JCS-style): object keys sorted by UTF-16
 * code unit, no insignificant whitespace, `undefined` properties dropped.
 *
 * This is the byte-level contract behind receipt signatures and the §11
 * cross-language golden files, so it is deliberately strict:
 *
 * - non-integer and non-finite numbers are rejected (float formatting differs
 *   between languages — encode fractional values as decimal strings)
 * - bigints are rejected (encode as decimal strings, like receipt `amount`)
 * - functions, symbols and class instances with custom `toJSON` are rejected
 */
export function canonicalJson(value: unknown): string {
  return write(value, new WeakSet());
}

export function canonicalBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJson(value));
}

function write(value: unknown, seen: WeakSet<object>): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number": {
      if (!Number.isFinite(value)) {
        throw new CanonicalJsonError(`non-finite number is not canonicalizable: ${value}`);
      }
      if (!Number.isInteger(value)) {
        throw new CanonicalJsonError(
          `non-integer number ${value} is not canonicalizable; use a decimal string`,
        );
      }
      // Number.isInteger(-0) is true and String(-0) is "0", so -0 normalizes.
      return String(value);
    }
    case "bigint":
      throw new CanonicalJsonError(
        `bigint ${value} is not canonicalizable; encode it as a decimal string`,
      );
    case "undefined":
      throw new CanonicalJsonError("undefined is not canonicalizable");
    case "object":
      break;
    default:
      throw new CanonicalJsonError(`${typeof value} is not canonicalizable`);
  }

  const obj = value as object;
  if (seen.has(obj)) throw new CanonicalJsonError("circular reference");
  seen.add(obj);
  try {
    if (Array.isArray(obj)) {
      const items = obj.map((item) => write(item === undefined ? null : item, seen));
      return `[${items.join(",")}]`;
    }
    if (Object.getPrototypeOf(obj) !== Object.prototype && Object.getPrototypeOf(obj) !== null) {
      throw new CanonicalJsonError(
        `only plain objects are canonicalizable, got ${obj.constructor?.name ?? "unknown"}`,
      );
    }
    const record = obj as Record<string, unknown>;
    // Default sort compares UTF-16 code units, which is what JCS specifies.
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    const entries = keys.map((key) => `${JSON.stringify(key)}:${write(record[key], seen)}`);
    return `{${entries.join(",")}}`;
  } finally {
    seen.delete(obj);
  }
}
