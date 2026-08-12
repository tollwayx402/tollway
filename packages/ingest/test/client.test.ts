import { describe, expect, it, vi } from "vitest";
import type { TollwayEvent } from "@tollway/core";
import { createIngestClient } from "../src/client.js";

function event(id: string, type: TollwayEvent["type"] = "toll.settled"): TollwayEvent {
  return { id, v: 1, type, ts: 1_765_432_100_000, route: "/v1/report", merchant: "acct_9d2", data: {} };
}

interface Capture {
  fetch: typeof fetch;
  requests: Array<{ headers: Record<string, string>; body: Uint8Array; events: TollwayEvent[] }>;
}

function capturingFetch(respond: (attempt: number) => Response | Promise<Response>): Capture {
  const requests: Capture["requests"] = [];
  let attempt = 0;
  const impl = (async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    attempt += 1;
    const raw = init?.body as Uint8Array;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = v;
    }
    let text: string;
    if (headers["content-encoding"] === "gzip") {
      const stream = new Blob([raw as unknown as BlobPart])
        .stream()
        .pipeThrough(new DecompressionStream("gzip"));
      text = await new Response(stream).text();
    } else {
      text = new TextDecoder().decode(raw);
    }
    requests.push({ headers, body: raw, events: JSON.parse(text).events as TollwayEvent[] });
    return respond(attempt);
  }) as typeof fetch;
  return { fetch: impl, requests };
}

const ok = () => new Response("{}", { status: 202 });

describe("batching", () => {
  it("does not touch the network until the batch or the timer says so", async () => {
    const capture = capturingFetch(ok);
    const client = createIngestClient({
      apiKey: "k",
      fetchImpl: capture.fetch,
      flushIntervalMs: 10_000,
      maxBatchSize: 100,
    });

    for (let i = 0; i < 99; i++) client.sink(event(`e${i}`));
    expect(capture.requests).toHaveLength(0);
    expect(client.stats.buffered).toBe(99);

    // The 100th trips the size trigger (§7).
    client.sink(event("e99"));
    await client.flush();
    expect(capture.requests).toHaveLength(1);
    expect(capture.requests[0]?.events).toHaveLength(100);
  });

  it("flushes on the interval when the batch never fills", async () => {
    vi.useFakeTimers();
    try {
      const capture = capturingFetch(ok);
      const client = createIngestClient({
        apiKey: "k",
        fetchImpl: capture.fetch,
        flushIntervalMs: 5_000,
      });

      client.sink(event("e1"));
      expect(capture.requests).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(5_000);
      expect(capture.requests).toHaveLength(1);
      expect(capture.requests[0]?.events.map((e) => e.id)).toEqual(["e1"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends the API key and gzips a body over the threshold", async () => {
    const capture = capturingFetch(ok);
    const client = createIngestClient({
      apiKey: "secret-key",
      fetchImpl: capture.fetch,
      gzipThresholdBytes: 0,
    });

    client.sink(event("e1"));
    await client.flush();

    expect(capture.requests[0]?.headers["authorization"]).toBe("Bearer secret-key");
    expect(capture.requests[0]?.headers["content-encoding"]).toBe("gzip");
    expect(capture.requests[0]?.events.map((e) => e.id)).toEqual(["e1"]);
  });

  it("leaves a small body uncompressed", async () => {
    const capture = capturingFetch(ok);
    const client = createIngestClient({
      apiKey: "k",
      fetchImpl: capture.fetch,
      gzipThresholdBytes: 1_000_000,
    });
    client.sink(event("e1"));
    await client.flush();
    expect(capture.requests[0]?.headers["content-encoding"]).toBeUndefined();
  });

  it("never blocks or throws in the request path", () => {
    const client = createIngestClient({
      apiKey: "k",
      fetchImpl: (() => {
        throw new Error("network is on fire");
      }) as unknown as typeof fetch,
    });
    expect(() => client.sink(event("e1"))).not.toThrow();
  });
});

describe("at-least-once delivery", () => {
  it("retries a 5xx with the same event ids, preserving order", async () => {
    const capture = capturingFetch((attempt) =>
      attempt === 1 ? new Response("", { status: 503 }) : ok(),
    );
    const client = createIngestClient({
      apiKey: "k",
      fetchImpl: capture.fetch,
      retryBaseMs: 1,
      jitter: () => 0,
    });

    client.sink(event("e1"));
    client.sink(event("e2"));
    await client.flush();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await client.flush();

    expect(capture.requests).toHaveLength(2);
    // Same ids twice: the server dedupes by id, which is what makes
    // at-least-once safe rather than duplicating revenue.
    expect(capture.requests[0]?.events.map((e) => e.id)).toEqual(["e1", "e2"]);
    expect(capture.requests[1]?.events.map((e) => e.id)).toEqual(["e1", "e2"]);
    expect(client.stats.sent).toBe(2);
  });

  it("retries a 429 rather than discarding", async () => {
    const capture = capturingFetch((attempt) =>
      attempt === 1 ? new Response("", { status: 429 }) : ok(),
    );
    const client = createIngestClient({
      apiKey: "k",
      fetchImpl: capture.fetch,
      retryBaseMs: 1,
      jitter: () => 0,
    });
    client.sink(event("e1"));
    await client.flush();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await client.flush();
    expect(client.stats.sent).toBe(1);
  });

  it("discards a 4xx instead of retrying forever", async () => {
    // A bad key or malformed batch will never succeed. Retrying it would mean
    // never sending anything again.
    const capture = capturingFetch(() => new Response("bad key", { status: 401 }));
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const client = createIngestClient({ apiKey: "k", fetchImpl: capture.fetch, logger });

    client.sink(event("e1"));
    await client.flush();

    expect(client.stats.abandoned).toBe(1);
    expect(client.stats.buffered).toBe(0);
    expect(logger.error).toHaveBeenCalled();
  });

  it("gives up after maxAttempts rather than growing forever", async () => {
    const capture = capturingFetch(() => new Response("", { status: 503 }));
    const client = createIngestClient({
      apiKey: "k",
      fetchImpl: capture.fetch,
      maxAttempts: 3,
      retryBaseMs: 1,
      jitter: () => 0,
    });

    client.sink(event("e1"));
    for (let i = 0; i < 4; i++) {
      await client.flush();
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(client.stats.abandoned).toBeGreaterThan(0);
    expect(client.stats.buffered).toBe(0);
  });
});

describe("overflow", () => {
  it("drops oldest at the cap and reports the loss in the stream", async () => {
    const capture = capturingFetch(ok);
    const client = createIngestClient({
      apiKey: "k",
      fetchImpl: capture.fetch,
      flushIntervalMs: 10_000,
      maxBatchSize: 10_000,
      maxBufferedEvents: 10,
    });

    for (let i = 0; i < 15; i++) client.sink(event(`e${i}`));
    await client.flush();

    expect(client.stats.dropped).toBe(5);
    const ids = capture.requests.flatMap((r) => r.events.map((e) => e.id));
    // Oldest went, newest survived.
    expect(ids).not.toContain("e0");
    expect(ids).toContain("e14");

    // §7: the loss is visible in the dashboard, not only in a log.
    const overflow = capture.requests
      .flatMap((r) => r.events)
      .find((e) => e.type === "gate.error" && e.data["code"] === "ingest_overflow");
    expect(overflow).toBeDefined();
    expect(overflow?.data["dropped"]).toBe(5);
  });

  it("reports overflow once per cycle, not once per dropped event", async () => {
    const capture = capturingFetch(ok);
    const client = createIngestClient({
      apiKey: "k",
      fetchImpl: capture.fetch,
      flushIntervalMs: 10_000,
      maxBatchSize: 10_000,
      maxBufferedEvents: 5,
    });

    for (let i = 0; i < 50; i++) client.sink(event(`e${i}`));
    await client.flush();

    const overflows = capture.requests
      .flatMap((r) => r.events)
      .filter((e) => e.data["code"] === "ingest_overflow");
    expect(overflows).toHaveLength(1);
  });
});

describe("lifecycle", () => {
  it("flushes on close and ignores events afterwards", async () => {
    const capture = capturingFetch(ok);
    const client = createIngestClient({ apiKey: "k", fetchImpl: capture.fetch });

    client.sink(event("e1"));
    await client.close();
    expect(capture.requests).toHaveLength(1);

    client.sink(event("e2"));
    await client.flush();
    expect(capture.requests).toHaveLength(1);
  });

  it("refuses to start without an API key", () => {
    expect(() => createIngestClient({ apiKey: "" })).toThrow(/apiKey is required/);
  });
});
