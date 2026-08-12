import { describe, expect, it } from "vitest";
import { CanonicalJsonError, canonicalBytes, canonicalJson } from "../src/index.js";

describe("canonicalJson", () => {
  it("sorts keys by code unit at every level", () => {
    expect(canonicalJson({ b: 1, a: 2, A: 3 })).toBe('{"A":3,"a":2,"b":1}');
    expect(canonicalJson({ z: { y: 1, x: [{ b: 1, a: 2 }] } })).toBe(
      '{"z":{"x":[{"a":2,"b":1}],"y":1}}',
    );
  });

  it("is insensitive to insertion order", () => {
    const a = canonicalJson({ route: "/v1/report", amount: "4000", v: 1 });
    const b = canonicalJson({ v: 1, amount: "4000", route: "/v1/report" });
    expect(a).toBe(b);
  });

  it("drops undefined properties but preserves nulls", () => {
    expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}');
    expect(canonicalJson([1, undefined, 2])).toBe("[1,null,2]");
  });

  it("normalizes -0 and rejects values that differ across languages", () => {
    expect(canonicalJson({ n: -0 })).toBe('{"n":0}');
    expect(() => canonicalJson({ n: 0.1 })).toThrow(CanonicalJsonError);
    expect(() => canonicalJson({ n: Number.NaN })).toThrow(CanonicalJsonError);
    expect(() => canonicalJson({ n: Infinity })).toThrow(CanonicalJsonError);
    expect(() => canonicalJson({ n: 1n })).toThrow(/decimal string/);
    expect(() => canonicalJson({ d: new Date(0) })).toThrow(CanonicalJsonError);
  });

  it("rejects circular structures", () => {
    const loop: Record<string, unknown> = {};
    loop["self"] = loop;
    expect(() => canonicalJson(loop)).toThrow(/circular/);
  });

  it("escapes strings the way JSON does", () => {
    const escaped = canonicalJson({ s: 'a"b\\c\nd' });
    expect(escaped).toBe(String.raw`{"s":"a\"b\\c\nd"}`);
    // Control characters take the \u form; non-ASCII stays literal, because the
    // signing contract is UTF-8 bytes rather than an ASCII-escaped form.
    const control = String.fromCharCode(1);
    expect(canonicalJson({ s: control })).toBe(JSON.stringify({ s: control }));
    expect(canonicalJson({ s: "héllo → ok" })).toBe('{"s":"héllo → ok"}');
  });

  it("encodes to UTF-8 bytes", () => {
    expect(new TextDecoder().decode(canonicalBytes({ s: "é" }))).toBe('{"s":"é"}');
    expect(canonicalBytes({ s: "é" })).toHaveLength(10);
  });
});
