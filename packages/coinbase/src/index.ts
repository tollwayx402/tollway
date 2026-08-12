/**
 * `@tollway/coinbase` — the Coinbase/CDP x402 facilitator adapter.
 *
 * Speaks the facilitator HTTP contract from `x402@1.2.0`: `POST /verify` and
 * `POST /settle`, both taking `{ x402Version, paymentPayload, paymentRequirements }`.
 */
import {
  FacilitatorUnreachableError,
  registerFacilitator,
  type ChallengeRequest,
  type ChallengeScheme,
  type FacilitatorAdapter,
  type Network,
  type PaymentPayload,
  type VerifyContext,
  type VerifyResult,
} from "@tollway/core";
import { DEFAULT_FACILITATOR_URL } from "./constants.js";
import { SUPPORTED_NETWORKS, assetConfig } from "./networks.js";
import { isFacilitatorFault, rejectCodeFor } from "./reasons.js";

export { NETWORKS, SUPPORTED_NETWORKS, assetConfig } from "./networks.js";
export type { AssetConfig, NetworkConfig } from "./networks.js";
export { isFacilitatorFault, rejectCodeFor } from "./reasons.js";

export { CDP_FACILITATOR_URL, DEFAULT_FACILITATOR_URL } from "./constants.js";
export {
  measureClockSkew,
  SKEW_CRITICAL_MS,
  SKEW_WARN_MS,
  type ClockSkew,
  type ClockSkewOptions,
} from "./skew.js";

export interface AuthHeaders {
  verify: Record<string, string>;
  settle: Record<string, string>;
}

export interface CoinbaseFacilitatorOptions {
  /** Facilitator base URL. Defaults to the public one. */
  url?: string;
  /**
   * Per-request auth headers. CDP wants a signed JWT; produce it with
   * `@coinbase/x402`'s `createCdpAuthHeaders()` and pass it straight through.
   * The adapter never sees or stores a key.
   */
  createAuthHeaders?: () => Promise<AuthHeaders> | AuthHeaders;
  /** Networks to advertise. Defaults to every network the adapter knows. */
  networks?: Network[];
  /** Injected for tests and recorded fixtures. Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Per-HTTP-call timeout. The gate applies its own outer budget too. */
  timeoutMs?: number;
  /**
   * Settle as part of verification (default true). When false the adapter only
   * verifies, and the merchant is responsible for settling — see README.
   */
  settle?: boolean;
  id?: string;
}

interface FacilitatorResponse {
  status: number;
  body: unknown;
}

export function coinbaseFacilitator(
  options: CoinbaseFacilitatorOptions = {},
): FacilitatorAdapter {
  const url = (options.url ?? DEFAULT_FACILITATOR_URL).replace(/\/+$/, "");
  const networks = options.networks ?? SUPPORTED_NETWORKS;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const shouldSettle = options.settle ?? true;
  const id = options.id ?? "coinbase";
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  if (typeof fetchImpl !== "function") {
    throw new Error("no fetch implementation available; pass `fetchImpl`");
  }

  async function call(
    path: "verify" | "settle",
    payload: PaymentPayload,
    requirements: ChallengeScheme,
    signal: AbortSignal,
  ): Promise<FacilitatorResponse> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (options.createAuthHeaders) {
      const auth = await options.createAuthHeaders();
      Object.assign(headers, path === "verify" ? auth.verify : auth.settle);
    }

    // The gate has already given up — do not open a connection we know is
    // doomed, and do not depend on the fetch implementation to notice.
    if (signal.aborted) {
      throw new FacilitatorUnreachableError(
        `facilitator ${path} call abandoned before it started: the gate's verify budget was already spent`,
        { facilitator: id, cause: signal.reason },
      );
    }

    const controller = new AbortController();
    const onAbort = () => controller.abort(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      controller.abort(new Error(`facilitator ${path} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    try {
      const response = await fetchImpl(`${url}/${path}`, {
        method: "POST",
        headers,
        signal: controller.signal,
        body: JSON.stringify({
          x402Version: payload.x402Version,
          paymentPayload: payload,
          paymentRequirements: requirements,
        }),
      });
      const text = await response.text();
      let body: unknown;
      try {
        body = text.length > 0 ? JSON.parse(text) : undefined;
      } catch {
        // A non-JSON body from a payment facilitator means something is between
        // us and it (proxy, captive portal, error page) — an outage, not a
        // verdict.
        throw new FacilitatorUnreachableError(
          `facilitator ${path} returned a non-JSON body (status ${response.status})`,
          { facilitator: id },
        );
      }
      return { status: response.status, body };
    } catch (error) {
      if (error instanceof FacilitatorUnreachableError) throw error;
      throw new FacilitatorUnreachableError(
        `facilitator ${path} call failed: ${error instanceof Error ? error.message : String(error)}`,
        { facilitator: id, cause: error },
      );
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
  }

  return {
    id,
    networks,

    buildChallenge(req: ChallengeRequest): ChallengeScheme {
      const asset = assetConfig(req.network, req.asset);
      return {
        scheme: "exact",
        network: req.network,
        maxAmountRequired: req.amount.toString(),
        resource: req.resource,
        description: req.description,
        mimeType: req.mimeType,
        payTo: req.payTo,
        maxTimeoutSeconds: req.maxTimeoutSeconds,
        asset: asset.address,
        // `extra` is the EIP-712 domain the payer signs under — it is not a
        // free slot for our own metadata. The challenge nonce deliberately does
        // not live here; replay protection is keyed on the payload hash instead
        // (core PROTOCOL.md §5).
        extra: { name: asset.eip712.name, version: asset.eip712.version },
      };
    },

    async verify(payload: PaymentPayload, ctx: VerifyContext): Promise<VerifyResult> {
      const verifyResponse = await call("verify", payload, ctx.scheme, ctx.signal);
      const verifyBody = asRecord(verifyResponse.body);

      if (verifyBody === undefined || typeof verifyBody["isValid"] !== "boolean") {
        // No verdict in the body: the facilitator did not answer the question.
        throw new FacilitatorUnreachableError(
          `facilitator verify returned an unrecognised body (status ${verifyResponse.status})`,
          { facilitator: id },
        );
      }

      if (verifyBody["isValid"] !== true) {
        const reason = stringOrUndefined(verifyBody["invalidReason"]);
        if (isFacilitatorFault(reason, "verify")) {
          throw new FacilitatorUnreachableError(`facilitator verify failed: ${reason}`, {
            facilitator: id,
          });
        }
        return {
          ok: false,
          code: rejectCodeFor(reason),
          message: reason ? `facilitator rejected the payment: ${reason}` : undefined,
          raw: verifyBody,
        };
      }

      const payer = stringOrUndefined(verifyBody["payer"]);

      if (!shouldSettle) {
        return {
          ok: true,
          txRef: `unsettled:${payload.network}`,
          settledAmount: ctx.requirements.amount,
          payer: payer ?? "unknown",
          raw: verifyBody,
        };
      }

      const settleResponse = await call("settle", payload, ctx.scheme, ctx.signal);
      const settleBody = asRecord(settleResponse.body);

      if (settleBody === undefined || typeof settleBody["success"] !== "boolean") {
        // Money may or may not have moved. Fail as unreachable so the merchant's
        // mode decides, rather than serving a request we cannot prove was paid.
        throw new FacilitatorUnreachableError(
          `facilitator settle returned an unrecognised body (status ${settleResponse.status})`,
          { facilitator: id },
        );
      }

      if (settleBody["success"] !== true) {
        const reason = stringOrUndefined(settleBody["errorReason"]);
        if (isFacilitatorFault(reason, "settle")) {
          throw new FacilitatorUnreachableError(`facilitator settle failed: ${reason}`, {
            facilitator: id,
          });
        }
        return {
          ok: false,
          code: rejectCodeFor(reason),
          message: reason ? `settlement failed: ${reason}` : "settlement failed",
          raw: settleBody,
        };
      }

      const transaction = stringOrUndefined(settleBody["transaction"]);
      // A failed settle carries a placeholder here ("0x") rather than an empty
      // string, so presence alone proves nothing — only `success` does, and a
      // placeholder alongside success:true means we cannot cite a transaction.
      if (transaction === undefined || transaction === "0x") {
        throw new FacilitatorUnreachableError(
          "facilitator reported a successful settlement with no transaction reference",
          { facilitator: id },
        );
      }

      return {
        ok: true,
        txRef: transaction,
        // The facilitator settles the authorized amount, which is the amount we
        // advertised — it does not report a separate figure.
        settledAmount: ctx.requirements.amount,
        payer: stringOrUndefined(settleBody["payer"]) ?? payer ?? "unknown",
        raw: settleBody,
      };
    },
  };
}

/** Register under "coinbase" so `facilitator: "coinbase"` resolves (§3.1). */
export function registerCoinbaseFacilitator(
  options: CoinbaseFacilitatorOptions = {},
): FacilitatorAdapter {
  const adapter = coinbaseFacilitator(options);
  registerFacilitator(adapter);
  return adapter;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
