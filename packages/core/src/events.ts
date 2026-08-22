import type { Logger } from "./types.js";
import { silentLogger } from "./logger.js";

/** §7 event types. */
export type EventType =
  | "challenge.issued"
  | "toll.settled"
  | "toll.rejected"
  | "request.served"
  | "request.failed"
  | "gate.error";

export interface OctroiEvent<D = Record<string, unknown>> {
  id: string;
  v: 1;
  type: EventType;
  /** Unix milliseconds. */
  ts: number;
  route: string;
  /** Account id in cloud mode, null standalone. */
  merchant: string | null;
  data: D;
}

export type EventSink = (event: OctroiEvent) => void | Promise<void>;

export interface EventBusOptions {
  sinks?: EventSink[];
  merchant?: string | null;
  logger?: Logger;
  clock?: () => number;
  newId?: () => string;
}

/**
 * Fan-out with an internal queue (§7): `emit` is synchronous, never throws, and
 * never awaits a sink — the request path is not allowed to pay for event
 * delivery. Sinks are invoked serially in emit order, and a throwing sink is
 * logged and stepped over rather than stalling the queue.
 */
export class EventBus {
  readonly #sinks: EventSink[];
  readonly #merchant: string | null;
  readonly #logger: Logger;
  readonly #clock: () => number;
  readonly #newId: () => string;
  readonly #queue: OctroiEvent[] = [];
  #draining = false;
  #pump: Promise<void> = Promise.resolve();

  constructor(options: EventBusOptions = {}) {
    this.#sinks = [...(options.sinks ?? [])];
    this.#merchant = options.merchant ?? null;
    this.#logger = options.logger ?? silentLogger;
    this.#clock = options.clock ?? (() => Date.now());
    this.#newId = options.newId ?? (() => `evt_${Math.random().toString(16).slice(2)}`);
  }

  /** Register an extra sink (the cloud ingest client attaches this way). */
  addSink(sink: EventSink): void {
    this.#sinks.push(sink);
  }

  emit<D extends Record<string, unknown>>(
    type: EventType,
    route: string,
    data: D,
  ): OctroiEvent<D> {
    const event: OctroiEvent<D> = {
      id: this.#newId(),
      v: 1,
      type,
      ts: this.#clock(),
      route,
      merchant: this.#merchant,
      data,
    };
    this.#queue.push(event as OctroiEvent);
    this.#kick();
    return event;
  }

  /** Await delivery of everything queued so far. For tests and shutdown. */
  async flush(): Promise<void> {
    while (this.#queue.length > 0 || this.#draining) {
      await this.#pump;
    }
  }

  #kick(): void {
    if (this.#draining) return;
    this.#draining = true;
    // Deferred to a microtask so that `emit` returns before any sink code runs
    // — an async sink still executes its synchronous prefix eagerly otherwise,
    // which would put sink latency back on the request path.
    this.#pump = Promise.resolve().then(() => this.#drain());
  }

  async #drain(): Promise<void> {
    try {
      let event = this.#queue.shift();
      while (event !== undefined) {
        for (const sink of this.#sinks) {
          try {
            await sink(event);
          } catch (error) {
            this.#logger.warn("octroi: event sink threw", {
              event_id: event.id,
              type: event.type,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
        event = this.#queue.shift();
      }
    } finally {
      this.#draining = false;
    }
  }
}
