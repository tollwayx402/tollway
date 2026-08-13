import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ERROR_DOCS, errorDocsHtml } from "../src/docs.js";

/** Every string that appears as an error code anywhere in shipped source. */
function emittedCodes(): Set<string> {
  const roots = [
    join(__dirname, "../../../packages/core/src"),
    join(__dirname, "../../../packages/coinbase/src"),
    join(__dirname, "../src"),
  ];
  const sources: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith(".ts")) sources.push(readFileSync(path, "utf8"));
    }
  };
  roots.forEach(walk);

  const codes = new Set<string>();
  for (const text of sources) {
    // errorBody(…) is the §10 envelope constructor — the single funnel every
    // emitted code passes through. Codes can arrive via ternaries, so collect
    // every snake_case literal within the call's argument span.
    for (const call of text.matchAll(/errorBody\(([^;]{0,200})/g)) {
      for (const literal of call[1]!.matchAll(/"([a-z0-9_]+)"/g)) codes.add(literal[1]!);
    }
    for (const match of text.matchAll(/rejectMessage\("([a-z_0-9]+)"\)/g)) codes.add(match[1]!);
    // 402 bodies flow through buildChallengeBody(accepts, "<code>", …).
    for (const match of text.matchAll(/buildChallengeBody\(\s*[\w.?[\]]+,\s*\n?\s*"([a-z_0-9]+)"/g)) {
      codes.add(match[1]!);
    }
  }
  // RejectCodes reach bodies through variables, not literals — add the union.
  for (const code of ["invalid_payment", "expired", "wrong_amount", "wrong_network", "replay"]) {
    codes.add(code);
  }
  return codes;
}

describe("the error reference", () => {
  it("documents every code the SDK and service actually emit", () => {
    const documented = new Set(ERROR_DOCS.map((doc) => doc.code));
    const missing = [...emittedCodes()].filter((code) => !documented.has(code));
    // A code without a docs entry ships a dead link in every error body.
    expect(missing).toEqual([]);
  });

  it("has no stale entries for codes nothing emits", () => {
    const emitted = emittedCodes();
    const stale = ERROR_DOCS.map((d) => d.code).filter((code) => !emitted.has(code));
    expect(stale).toEqual([]);
  });

  it("renders one anchored section per code", () => {
    const html = errorDocsHtml();
    for (const doc of ERROR_DOCS) {
      expect(html).toContain(`id="${doc.code}"`);
    }
    expect(html).not.toContain("<script");
  });
});
