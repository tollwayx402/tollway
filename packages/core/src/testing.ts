/**
 * Test doubles. Published as `@octroi/core/testing` so adapter packages can
 * build against a facilitator without a network, and so the §11 contract-test
 * suite has a reference implementation to check itself against.
 */
import { FacilitatorUnreachableError } from "./errors.js";
import type {
  ChallengeRequest,
  ChallengeScheme,
  FacilitatorAdapter,
  Network,
  PaymentPayload,
  VerifyContext,
  VerifyResult,
} from "./types.js";

export interface MockFacilitatorOptions {
  id?: string;
  networks?: Network[];
  scheme?: string;
  /** Token address advertised per network. */
  assetAddress?: string;
  /** Override verification wholesale. */
  verify?: (payload: PaymentPayload, ctx: VerifyContext) => Promise<VerifyResult> | VerifyResult;
  /** Throw as if the facilitator were unreachable. */
  unreachable?: boolean;
  /** Delay every verify by this many ms (for timeout tests). */
  latencyMs?: number;
}

export interface MockFacilitator extends FacilitatorAdapter {
  /** Every (payload, ctx) pair the gate handed over. */
  readonly calls: Array<{ payload: PaymentPayload; ctx: VerifyContext }>;
  readonly challenges: ChallengeRequest[];
}

/**
 * Default behaviour: accepts any payload carrying `{ txRef, amount, payer }`,
 * settling exactly what the payload claims — so tests drive the outcome from
 * the request side.
 */
export function createMockFacilitator(options: MockFacilitatorOptions = {}): MockFacilitator {
  const calls: Array<{ payload: PaymentPayload; ctx: VerifyContext }> = [];
  const challenges: ChallengeRequest[] = [];
  const id = options.id ?? "mock";
  const networks = options.networks ?? ["base-sepolia"];
  const scheme = options.scheme ?? "exact";

  return {
    id,
    networks,
    calls,
    challenges,
    buildChallenge(req: ChallengeRequest): ChallengeScheme {
      challenges.push(req);
      return {
        scheme,
        network: req.network,
        maxAmountRequired: req.amount.toString(),
        resource: req.resource,
        description: req.description,
        mimeType: req.mimeType,
        payTo: req.payTo,
        maxTimeoutSeconds: req.maxTimeoutSeconds,
        asset: options.assetAddress ?? `0xasset-${req.network}`,
        extra: { nonce: req.nonce, expiresAt: req.expiresAt },
      };
    },
    async verify(payload: PaymentPayload, ctx: VerifyContext): Promise<VerifyResult> {
      calls.push({ payload, ctx });
      if (options.latencyMs) await sleep(options.latencyMs);
      if (options.unreachable) {
        throw new FacilitatorUnreachableError(`mock facilitator "${id}" is down`, {
          facilitator: id,
        });
      }
      if (options.verify) return options.verify(payload, ctx);

      const body = payload.payload;
      const amount = body["amount"];
      const txRef = body["txRef"];
      const payer = body["payer"];
      if (typeof txRef !== "string" || typeof payer !== "string") {
        return { ok: false, code: "invalid_payment", message: "mock payload needs txRef + payer" };
      }
      return {
        ok: true,
        txRef,
        payer,
        settledAmount: typeof amount === "string" ? amount : ctx.requirements.amount,
      };
    },
  };
}

/** Encode a payload the way an agent would send it in `X-PAYMENT`. */
export function encodePaymentHeader(payload: PaymentPayload): string {
  const json = JSON.stringify(payload);
  const bytes = new TextEncoder().encode(json);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** A payment the default mock facilitator accepts. */
export function mockPayment(
  overrides: Partial<PaymentPayload> & { amount?: string; txRef?: string; payer?: string } = {},
): PaymentPayload {
  const { amount, txRef, payer, payload, ...rest } = overrides;
  return {
    x402Version: 1,
    scheme: "exact",
    network: "base-sepolia",
    payload: {
      txRef: txRef ?? "0xtx-1",
      payer: payer ?? "0xpayer-1",
      ...(amount === undefined ? {} : { amount }),
      ...payload,
    },
    ...rest,
  };
}

/** Deterministic clock for golden files and event-ordering tests. */
export function fixedClock(startMs: number, stepMs = 0): () => number {
  let current = startMs;
  return () => {
    const value = current;
    current += stepMs;
    return value;
  };
}

/** Deterministic id generator: `oct_<prefix>_0001`, `oct_<prefix>_0002`, … */
export function counterIds(): (prefix: string) => string {
  const counters = new Map<string, number>();
  return (prefix) => {
    const next = (counters.get(prefix) ?? 0) + 1;
    counters.set(prefix, next);
    return `oct_${prefix}_${next.toString().padStart(4, "0")}`;
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
