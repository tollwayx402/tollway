/**
 * The edge-runtime contract.
 *
 * `@tollway/core` and `@tollway/hono` must run unmodified on Cloudflare
 * Workers, Deno and Bun. Nothing in the type system enforces that: a single
 * `import { randomBytes } from "node:crypto"` compiles, tests green on Node,
 * and only fails at deploy. So it is asserted here, over the source.
 *
 * The `testing` module is exempt from the *timer* rules (it fakes latency) but
 * not from the import rules.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));

function sourcesOf(packageDir: string): Array<{ file: string; text: string }> {
  const dir = join(here, "..", "..", packageDir, "src");
  return readdirSync(dir)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => ({ file: `${packageDir}/src/${name}`, text: readFileSync(join(dir, name), "utf8") }));
}

const sources = [...sourcesOf("core"), ...sourcesOf("hono")];

describe("edge portability", () => {
  it("covers both packages", () => {
    expect(sources.length).toBeGreaterThan(10);
  });

  it("imports no Node builtins", () => {
    const offenders = sources.filter(({ text }) =>
      /from\s+["']node:|require\(["']node:|from\s+["'](fs|path|crypto|zlib|http|net|os|buffer)["']/.test(
        text,
      ),
    );
    expect(offenders.map((o) => o.file)).toEqual([]);
  });

  it("uses no Node-only globals", () => {
    // `Buffer` and `process` do not exist on Workers. `globalThis.crypto`,
    // `btoa`/`atob`, `TextEncoder` and `fetch` do, which is why core is
    // written against those.
    const offenders = sources.filter(({ text }) =>
      /\bBuffer\.|\bprocess\.(env|exit|argv)\b|\b__dirname\b|\b__filename\b/.test(text),
    );
    expect(offenders.map((o) => o.file)).toEqual([]);
  });

  it("never unrefs a timer outside an explicitly optional call", () => {
    // `timer.unref()` is Node-only. Optional-chained (`unref?.()`) is fine.
    const offenders = sources.filter(({ text }) => /\.unref\(\)/.test(text));
    expect(offenders.map((o) => o.file)).toEqual([]);
  });

  it("keeps every crypto call on WebCrypto", () => {
    const cryptoUsers = sources.filter(({ text }) => /subtle\.|getRandomValues/.test(text));
    expect(cryptoUsers.length).toBeGreaterThan(0);
    for (const { file, text } of cryptoUsers) {
      expect(text, `${file} should reach WebCrypto through getCrypto()`).not.toMatch(
        /createHash|randomUUID\(\)|createPrivateKey/,
      );
    }
  });
});
