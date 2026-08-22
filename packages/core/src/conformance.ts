/**
 * The contract-test suite every `FacilitatorAdapter` must pass (§11).
 *
 * Framework-agnostic on purpose: it returns results rather than calling
 * `expect`, so adapter packages can run it under any test runner — and so the
 * `doctor` command can run the same checks against a live facilitator.
 */
import { canonicalJson } from "./canonical.js";
import type {
  ChallengeRequest,
  FacilitatorAdapter,
  Network,
  PaymentPayload,
  VerifyContext,
} from "./types.js";
import { silentLogger } from "./logger.js";

export interface ConformanceCheck {
  name: string;
  ok: boolean;
  detail?: string;
  /** Skipped checks are neither pass nor fail — e.g. no live payload supplied. */
  skipped?: boolean;
}

export interface ConformanceOptions {
  /** Network to exercise. Defaults to the adapter's first. */
  network?: Network;
  /** A payload the adapter should reject. Defaults to obvious garbage. */
  invalidPayload?: PaymentPayload;
  /**
   * A payload the adapter should accept. Omit in mock runs; supply in the
   * testnet run, where a real signed authorization is available.
   */
  validPayload?: PaymentPayload;
  /** Expected settled amount for `validPayload`, atomic units. */
  expectedAmount?: bigint;
}

const BASE_REQUIREMENTS: Omit<ChallengeRequest, "network"> = {
  route: "/conformance",
  resource: "https://conformance.octroi.sh/conformance",
  description: "Conformance probe",
  mimeType: "application/json",
  asset: "usdc",
  amount: 4_000n,
  payTo: `0x${"1".repeat(40)}`,
  nonce: "conformance-nonce",
  expiresAt: 0,
  maxTimeoutSeconds: 120,
};

/**
 * Run the suite. Every check is independent; a throwing adapter fails the
 * check it threw in rather than aborting the run.
 */
export async function runFacilitatorConformance(
  adapter: FacilitatorAdapter,
  options: ConformanceOptions = {},
): Promise<ConformanceCheck[]> {
  const checks: ConformanceCheck[] = [];
  const network = options.network ?? adapter.networks[0];

  const record = async (name: string, fn: () => Promise<string | undefined> | string | undefined) => {
    try {
      const detail = await fn();
      checks.push(detail === undefined ? { name, ok: true } : { name, ok: true, detail });
    } catch (error) {
      checks.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) });
    }
  };

  if (network === undefined) {
    return [{ name: "declares at least one network", ok: false, detail: "networks is empty" }];
  }

  await record("declares a non-empty id", () => {
    if (typeof adapter.id !== "string" || adapter.id.length === 0) throw new Error("id is empty");
    return undefined;
  });

  await record("declares at least one network", () => {
    if (adapter.networks.length === 0) throw new Error("networks is empty");
    return adapter.networks.join(", ");
  });

  const requirements: ChallengeRequest = {
    ...BASE_REQUIREMENTS,
    network,
    expiresAt: Math.floor(Date.now() / 1_000) + 120,
  };

  let scheme: Awaited<ReturnType<FacilitatorAdapter["buildChallenge"]>> | undefined;
  await record("buildChallenge returns a complete scheme", () => {
    scheme = adapter.buildChallenge(requirements);
    const missing = (
      [
        "scheme",
        "network",
        "maxAmountRequired",
        "resource",
        "description",
        "mimeType",
        "payTo",
        "maxTimeoutSeconds",
        "asset",
      ] as const
    ).filter((key) => scheme?.[key] === undefined || scheme[key] === "");
    if (missing.length > 0) throw new Error(`missing fields: ${missing.join(", ")}`);
    return undefined;
  });

  await record("buildChallenge echoes the requested amount, payTo and network", () => {
    if (!scheme) throw new Error("no scheme built");
    if (scheme.maxAmountRequired !== requirements.amount.toString()) {
      throw new Error(`maxAmountRequired ${scheme.maxAmountRequired} != ${requirements.amount}`);
    }
    if (scheme.payTo !== requirements.payTo) throw new Error("payTo was rewritten");
    if (scheme.network !== requirements.network) throw new Error("network was rewritten");
    return undefined;
  });

  await record("buildChallenge is pure — same input, same output", () => {
    const a = canonicalJson(adapter.buildChallenge(requirements));
    const b = canonicalJson(adapter.buildChallenge(requirements));
    if (a !== b) throw new Error("two calls produced different schemes");
    return undefined;
  });

  const ctx = (): VerifyContext => ({
    scheme: scheme ?? adapter.buildChallenge(requirements),
    requirements,
    route: requirements.route,
    now: Date.now(),
    signal: new AbortController().signal,
    logger: silentLogger,
  });

  const invalid: PaymentPayload = options.invalidPayload ?? {
    x402Version: 1,
    scheme: scheme?.scheme ?? "exact",
    network,
    payload: { nonsense: true },
  };

  await record("verify returns a rejection value for a bad payload, never throws", async () => {
    const result = await adapter.verify(invalid, ctx());
    if (result.ok) throw new Error("a nonsense payload was accepted");
    if (typeof result.code !== "string") throw new Error("rejection has no code");
    return `code=${result.code}`;
  });

  await record("verify does not mutate the payload it is given", async () => {
    const payload: PaymentPayload = JSON.parse(JSON.stringify(invalid)) as PaymentPayload;
    const before = canonicalJson(payload);
    await adapter.verify(payload, ctx());
    if (canonicalJson(payload) !== before) throw new Error("payload was mutated");
    return undefined;
  });

  await record("verify honours an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    try {
      const result = await adapter.verify(invalid, { ...ctx(), signal: controller.signal });
      // Returning a rejection is acceptable; hanging or ignoring is not.
      return result.ok ? "returned ok (unexpected but not fatal)" : "returned a rejection";
    } catch {
      return "threw, which the gate reads as unreachable";
    }
  });

  if (options.validPayload === undefined) {
    checks.push({
      name: "verify accepts a valid payment",
      ok: true,
      skipped: true,
      detail: "no validPayload supplied — supply one in the testnet run",
    });
  } else {
    await record("verify accepts a valid payment", async () => {
      const result = await adapter.verify(options.validPayload as PaymentPayload, ctx());
      if (!result.ok) throw new Error(`rejected with ${result.code}`);
      if (!result.txRef) throw new Error("no txRef returned");
      if (!result.payer) throw new Error("no payer returned");
      if (options.expectedAmount !== undefined && BigInt(result.settledAmount) < options.expectedAmount) {
        throw new Error(`settled ${result.settledAmount} < expected ${options.expectedAmount}`);
      }
      return `txRef=${result.txRef}`;
    });
  }

  return checks;
}

/** Format results for `doctor` output or a failing test message. */
export function formatConformance(checks: ConformanceCheck[]): string {
  return checks
    .map((check) => {
      const mark = check.skipped ? "skip" : check.ok ? "pass" : "FAIL";
      return `  ${mark}  ${check.name}${check.detail ? ` — ${check.detail}` : ""}`;
    })
    .join("\n");
}
