/**
 * The cloud event client (§7 Delivery).
 *
 * Contract, verbatim from the spec: HTTPS, gzip, at-least-once, 5s flush or
 * 100 events, disk-less retry buffer capped at 10k events, drop-oldest with
 * `gate.error` emitted on overflow.
 *
 * The rule that shapes everything here: **the request path never pays for
 * event delivery**. `sink` is synchronous, allocation-cheap, and cannot throw.
 * Every network cost lives on a timer.
 */
import type { EventSink, Logger, TollwayEvent } from "@tollway/core";

export const DEFAULT_INGEST_URL = "https://ingest.tollway.sh";

export interface IngestClientOptions {
  apiKey: string;
  url?: string;
  /** Flush at most this often. Default 5s (§7). */
  flushIntervalMs?: number;
  /** Flush immediately at this many buffered events. Default 100 (§7). */
  maxBatchSize?: number;
  /** Retry buffer cap. Default 10_000 (§7). */
  maxBufferedEvents?: number;
  /** Compress bodies over this size. Default 1 KiB; set 0 to always gzip. */
  gzipThresholdBytes?: number;
  /** Give up on a batch after this many consecutive failures. */
  maxAttempts?: number;
  /** Base backoff; doubles per attempt, with jitter. Default 500ms. */
  retryBaseMs?: number;
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  logger?: Logger;
  clock?: () => number;
  /** Injected in tests so backoff is deterministic. */
  jitter?: () => number;
}

export interface IngestStats {
  buffered: number;
  sent: number;
  /** Events discarded by overflow — never silent, always in `gate.error`. */
  dropped: number;
  /** Batches abandoned after `maxAttempts`. */
  abandoned: number;
  consecutiveFailures: number;
}

export interface IngestClient {
  /** Attach to a gate: `sinks: [client.sink]`, or via `apiKey` on an adapter. */
  readonly sink: EventSink;
  /** Send everything buffered now. Resolves when the buffer is empty or given up on. */
  flush(): Promise<void>;
  /** Flush and stop timers. Safe to call twice. */
  close(): Promise<void>;
  readonly stats: IngestStats;
}

export function createIngestClient(options: IngestClientOptions): IngestClient {
  const url = (options.url ?? DEFAULT_INGEST_URL).replace(/\/+$/, "");
  const flushIntervalMs = options.flushIntervalMs ?? 5_000;
  const maxBatchSize = options.maxBatchSize ?? 100;
  const maxBufferedEvents = options.maxBufferedEvents ?? 10_000;
  const gzipThresholdBytes = options.gzipThresholdBytes ?? 1024;
  const maxAttempts = options.maxAttempts ?? 6;
  const retryBaseMs = options.retryBaseMs ?? 500;
  const requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const clock = options.clock ?? (() => Date.now());
  const jitter = options.jitter ?? Math.random;
  const log = options.logger;

  if (typeof fetchImpl !== "function") {
    throw new Error("@tollway/ingest: no fetch implementation available; pass `fetchImpl`");
  }
  if (options.apiKey.length === 0) {
    throw new Error("@tollway/ingest: apiKey is required");
  }

  const buffer: TollwayEvent[] = [];
  const stats: IngestStats = {
    buffered: 0,
    sent: 0,
    dropped: 0,
    abandoned: 0,
    consecutiveFailures: 0,
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | undefined;
  let closed = false;
  /**
   * Pending overflow report. Deliberately NOT stored in `buffer`: a marker in
   * the buffer both steals a slot from a real event and — worse — can itself be
   * dropped by the next overflow, losing the very report that says data was
   * lost. It rides along with the next batch instead, and is only cleared once
   * that batch is accepted.
   */
  let pendingOverflow: { dropped: number; at: number } | undefined;

  function scheduleFlush(): void {
    if (timer !== undefined || closed) return;
    timer = setTimeout(() => {
      timer = undefined;
      void flush();
    }, flushIntervalMs);
    // Never hold the process open for telemetry.
    timer.unref?.();
  }

  /**
   * Overflow (§7): drop oldest, and record that we did so. The report is sent
   * with the next batch (see `pendingOverflow`) rather than buffered, and is
   * never routed through `sink`, so it cannot feed back into itself.
   */
  function dropOldest(): void {
    const overflow = buffer.length - maxBufferedEvents;
    if (overflow <= 0) return;
    buffer.splice(0, overflow);
    stats.dropped += overflow;

    const first = pendingOverflow === undefined;
    pendingOverflow = { dropped: stats.dropped, at: clock() };
    if (first) {
      // Log once per episode, not once per dropped event: the whole point of
      // this path is that we are already under pressure.
      log?.warn("tollway: ingest buffer overflowed, dropping oldest events", {
        dropped: stats.dropped,
        cap: maxBufferedEvents,
      });
    }
  }

  /** §7: overflow is reported as a `gate.error` in the stream, not just a log. */
  function overflowEvent(report: { dropped: number; at: number }): TollwayEvent {
    return {
      id: `twy_evt_overflow_${report.at.toString(36)}_${report.dropped}`,
      v: 1,
      type: "gate.error",
      ts: report.at,
      route: "",
      merchant: null,
      data: {
        code: "ingest_overflow",
        message: `ingest buffer exceeded ${maxBufferedEvents} events; oldest dropped`,
        dropped: report.dropped,
      },
    };
  }

  const sink: EventSink = (event) => {
    if (closed) return;
    buffer.push(event);
    stats.buffered = buffer.length;
    if (buffer.length > maxBufferedEvents) dropOldest();
    if (buffer.length >= maxBatchSize) {
      void flush();
    } else {
      scheduleFlush();
    }
  };

  async function postBatch(batch: TollwayEvent[]): Promise<void> {
    const body = JSON.stringify({ events: batch });
    const raw = new TextEncoder().encode(body);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      authorization: `Bearer ${options.apiKey}`,
    };

    let payload: BodyInit = raw as unknown as BodyInit;
    if (raw.byteLength >= gzipThresholdBytes) {
      const compressed = await gzip(raw);
      if (compressed !== undefined) {
        payload = compressed as unknown as BodyInit;
        headers["content-encoding"] = "gzip";
      }
    }

    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      const response = await fetchImpl(`${url}/v1/events`, {
        method: "POST",
        headers,
        body: payload,
        signal: controller.signal,
      });
      if (response.status >= 500 || response.status === 429) {
        throw new Error(`ingest responded ${response.status}`);
      }
      if (!response.ok) {
        // 4xx is our fault (bad key, malformed batch). Retrying cannot fix it,
        // and retrying forever would mean never sending anything again.
        const text = await response.text().catch(() => "");
        throw Object.assign(new Error(`ingest rejected the batch: ${response.status} ${text.slice(0, 200)}`), {
          permanent: true,
        });
      }
    } finally {
      clearTimeout(abortTimer);
    }
  }

  async function flush(): Promise<void> {
    if (inFlight !== undefined) return inFlight;
    inFlight = (async () => {
      try {
        while (buffer.length > 0 || pendingOverflow !== undefined) {
          const batch = buffer.splice(0, maxBatchSize);
          const report = pendingOverflow;
          if (report !== undefined) batch.unshift(overflowEvent(report));
          if (batch.length === 0) break;

          try {
            await postBatch(batch);
            stats.sent += batch.length;
            stats.consecutiveFailures = 0;
            // Only now is the loss actually reported; clear it, unless more was
            // dropped while this batch was in flight.
            if (report !== undefined && pendingOverflow?.dropped === report.dropped) {
              pendingOverflow = undefined;
            }
          } catch (error) {
            // The marker is not a buffered event and must not be pushed back
            // into the buffer, where the next overflow could drop it.
            if (report !== undefined) batch.shift();
            const permanent = (error as { permanent?: boolean }).permanent === true;
            if (permanent) {
              stats.abandoned += batch.length;
              log?.error("tollway: ingest rejected a batch permanently, discarding it", {
                events: batch.length,
                error: error instanceof Error ? error.message : String(error),
              });
              continue;
            }

            // Put it back at the front: order is part of the contract, and
            // at-least-once means we would rather resend than lose.
            buffer.unshift(...batch);
            if (buffer.length > maxBufferedEvents) dropOldest();
            stats.consecutiveFailures += 1;

            if (stats.consecutiveFailures >= maxAttempts) {
              stats.abandoned += buffer.length;
              log?.error("tollway: ingest unreachable, giving up on the buffer", {
                events: buffer.length,
                attempts: stats.consecutiveFailures,
                error: error instanceof Error ? error.message : String(error),
              });
              buffer.length = 0;
              stats.consecutiveFailures = 0;
              return;
            }

            log?.warn("tollway: ingest flush failed, will retry", {
              attempt: stats.consecutiveFailures,
              buffered: buffer.length,
              error: error instanceof Error ? error.message : String(error),
            });
            if (!closed) scheduleRetry();
            return;
          }
        }
      } finally {
        stats.buffered = buffer.length;
        inFlight = undefined;
      }
    })();
    return inFlight;
  }

  function scheduleRetry(): void {
    if (timer !== undefined) return;
    const exponent = Math.min(stats.consecutiveFailures, 6);
    const delay = Math.round(retryBaseMs * 2 ** (exponent - 1) * (0.5 + jitter()));
    timer = setTimeout(() => {
      timer = undefined;
      void flush();
    }, delay);
    timer.unref?.();
  }

  return {
    sink,
    flush,
    async close(): Promise<void> {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      await flush();
      closed = true;
    },
    stats,
  };
}

/** gzip via the web standard, so this works on Node, Deno, Bun and Workers. */
async function gzip(bytes: Uint8Array): Promise<Uint8Array | undefined> {
  const Compression = (globalThis as { CompressionStream?: unknown }).CompressionStream;
  if (typeof Compression !== "function") return undefined;
  try {
    const stream = new Blob([bytes as unknown as BlobPart])
      .stream()
      .pipeThrough(new (Compression as typeof CompressionStream)("gzip"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return undefined;
  }
}
