/**
 * The example itself is under test: the app is a plain Hono export, so it runs
 * against `app.request` with a stubbed env — no wrangler, no network.
 */
import { describe, expect, it } from "vitest";
import app from "../src/index.js";

const env = { TW_ADDRESS: "0x1111111111111111111111111111111111111111" };

describe("hono-worker example", () => {
  it("answers an unpaid request with a client-parseable 402", async () => {
    const response = await app.request("https://example.workers.dev/v1/report", {}, env);
    expect(response.status).toBe(402);
    const body = (await response.json()) as {
      accepts: Array<{ network: string; asset: string; resource: string }>;
      errorDetail: { code: string };
    };
    expect(body.accepts[0]?.network).toBe("base-sepolia");
    expect(body.accepts[0]?.asset).toBe("0x036CbD53842c5426634e7929541eC2318f3dCF7e");
    expect(body.accepts[0]?.resource).toBe("https://example.workers.dev/v1/report");
    expect(body.errorDetail.code).toBe("payment_required");
  });
});
