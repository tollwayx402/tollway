import { describe, expect, it, vi } from "vitest";
import { EventBus } from "../src/index.js";
import type { OctroiEvent } from "../src/index.js";
import { counterIds, fixedClock } from "../src/testing.js";

function bus(sinks: Array<(e: OctroiEvent) => void | Promise<void>>) {
  const ids = counterIds();
  return new EventBus({
    sinks,
    clock: fixedClock(1_700_000_000_000, 1),
    newId: () => ids("evt"),
  });
}

describe("EventBus", () => {
  it("stamps events with id, version, ts, route and merchant", async () => {
    const seen: OctroiEvent[] = [];
    const b = new EventBus({
      sinks: [(e) => void seen.push(e)],
      merchant: "acct_9d2",
      clock: () => 1_700_000_000_000,
      newId: () => "oct_evt_0001",
    });

    const returned = b.emit("challenge.issued", "/v1/report", { nonce: "abc" });
    await b.flush();

    expect(returned).toEqual({
      id: "oct_evt_0001",
      v: 1,
      type: "challenge.issued",
      ts: 1_700_000_000_000,
      route: "/v1/report",
      merchant: "acct_9d2",
      data: { nonce: "abc" },
    });
    expect(seen).toEqual([returned]);
  });

  it("defaults merchant to null in standalone mode", async () => {
    const seen: OctroiEvent[] = [];
    const b = bus([(e) => void seen.push(e)]);
    b.emit("gate.error", "/v1/report", { mode: "fail_closed" });
    await b.flush();
    expect(seen[0]?.merchant).toBeNull();
  });

  it("delivers in emit order even when sinks are async and uneven", async () => {
    const order: string[] = [];
    const b = bus([
      async (e) => {
        // First event sleeps longest: ordering must not depend on sink speed.
        const delay = e.type === "challenge.issued" ? 20 : 0;
        await new Promise((resolve) => setTimeout(resolve, delay));
        order.push(`${e.type}:${e.id}`);
      },
    ]);

    b.emit("challenge.issued", "/r", {});
    b.emit("toll.settled", "/r", {});
    b.emit("request.served", "/r", {});
    await b.flush();

    expect(order).toEqual([
      "challenge.issued:oct_evt_0001",
      "toll.settled:oct_evt_0002",
      "request.served:oct_evt_0003",
    ]);
  });

  it("does not block the caller — emit returns before sinks run", async () => {
    const order: string[] = [];
    const b = bus([
      async () => {
        order.push("sink");
      },
    ]);

    b.emit("toll.settled", "/r", {});
    order.push("after-emit");
    await b.flush();

    expect(order).toEqual(["after-emit", "sink"]);
  });

  it("isolates a throwing sink from the rest of the queue", async () => {
    const good: string[] = [];
    const warn = vi.fn();
    const b = new EventBus({
      sinks: [
        () => {
          throw new Error("sink exploded");
        },
        (e) => void good.push(e.type),
      ],
      logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() },
      newId: counterIds().bind(null, "evt"),
    });

    expect(() => b.emit("toll.settled", "/r", {})).not.toThrow();
    b.emit("request.served", "/r", {});
    await b.flush();

    expect(good).toEqual(["toll.settled", "request.served"]);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("delivers events emitted from inside a sink", async () => {
    const seen: string[] = [];
    let reentered = false;
    const b: EventBus = new EventBus({
      sinks: [
        (e) => {
          seen.push(e.type);
          if (!reentered) {
            reentered = true;
            b.emit("gate.error", "/r", {});
          }
        },
      ],
      newId: counterIds().bind(null, "evt"),
    });

    b.emit("toll.settled", "/r", {});
    await b.flush();

    expect(seen).toEqual(["toll.settled", "gate.error"]);
  });

  it("accepts sinks registered after construction", async () => {
    const late: string[] = [];
    const b = bus([]);
    b.addSink((e) => void late.push(e.type));
    b.emit("toll.rejected", "/r", { code: "replay" });
    await b.flush();
    expect(late).toEqual(["toll.rejected"]);
  });
});
