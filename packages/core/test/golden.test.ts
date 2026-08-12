import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { goldenChallenge, goldenEvents, goldenReceipt } from "./fixtures/golden-case.js";

const GOLDEN_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../golden");
const UPDATE = process.env["UPDATE_GOLDEN"] === "1";

function check(name: string, actual: string) {
  const path = join(GOLDEN_DIR, name);
  if (UPDATE || !existsSync(path)) {
    mkdirSync(GOLDEN_DIR, { recursive: true });
    writeFileSync(path, `${actual}\n`, "utf8");
  }
  const expected = readFileSync(path, "utf8").trimEnd();
  expect(actual, `golden mismatch for ${name}; rerun with UPDATE_GOLDEN=1 if intended`).toBe(
    expected,
  );
}

/**
 * §11 — the same inputs must produce byte-identical output in TS and Python.
 * These files are the contract; the Python port checks itself against them.
 */
describe("golden files", () => {
  it("challenge body is byte-stable", async () => {
    check("challenge.json", await goldenChallenge());
  });

  it("receipt is byte-stable, signature included", async () => {
    check("receipt.json", await goldenReceipt());
  });

  it("event stream is byte-stable", async () => {
    check("events.json", await goldenEvents());
  });
});
