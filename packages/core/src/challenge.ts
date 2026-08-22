import { fromBase64 } from "./bytes.js";
import type { ErrorBody } from "./errors.js";
import { errorBody } from "./errors.js";
import type { ChallengeScheme, HeaderSource, PaymentPayload } from "./types.js";

/** Pinned x402 revision — see PROTOCOL.md before changing. */
export const X402_VERSION = 1;

/** Header the agent sends its payment payload in. */
export const PAYMENT_HEADER = "x-payment";
/** Header the receipt id is returned in (§6). */
export const RECEIPT_HEADER = "x-octroi-receipt";

/**
 * Body of a 402 — a superset, never a replacement (see PROTOCOL.md §1).
 *
 * - `error` is the spec-shaped string an x402 client library reads. It carries
 *   the machine code, not prose.
 * - `errorDetail` is the §10 envelope for humans and merchant tooling.
 *
 * The party parsing this body is the agent's client library, not the merchant,
 * so the spec field keeps the spec's name and type.
 */
export interface ChallengeBody {
  x402Version: number;
  accepts: ChallengeScheme[];
  /** Omitted when no x402 reason applies — the field is optional in the spec. */
  error?: string;
  errorDetail: ErrorBody["error"];
}

/**
 * x402 types `error` as an **optional closed enum** of reasons, not as free
 * text. Emitting our own code there fails `x402ResponseSchema.parse` in the
 * reference client, so we map onto the enum and keep our real code in
 * `errorDetail`.
 *
 * Verified against `x402@1.2.0` by `test/interop.test.ts`. When a Octroi code
 * has no enum equivalent — including `payment_required`, which is a first
 * contact rather than an error — the field is omitted.
 */
export const X402_ERROR_REASONS: Readonly<Record<string, string>> = {
  invalid_payment: "invalid_payment",
  expired: "payment_expired",
  wrong_network: "invalid_network",
  // No generic "underpaid" reason exists; the value-level reasons in the enum
  // are chain-specific, so this stays generic and errorDetail.code carries the
  // precise meaning.
  wrong_amount: "invalid_payment",
  replay: "duplicate_settlement",
};

export function x402ErrorReason(code: string): string | undefined {
  return X402_ERROR_REASONS[code];
}

export function buildChallengeBody(
  accepts: ChallengeScheme[],
  code: string,
  message: string,
): ChallengeBody {
  const reason = x402ErrorReason(code);
  return {
    x402Version: X402_VERSION,
    accepts,
    ...(reason === undefined ? {} : { error: reason }),
    errorDetail: errorBody(code, message).error,
  };
}

/**
 * Read the Octroi error envelope out of any SDK response body, 402 or not.
 * Adapters, `doctor` and client code should use this rather than reaching for
 * a key directly, since 402s carry it under `errorDetail` and everything else
 * under `error`.
 */
export function readErrorDetail(body: unknown): ErrorBody["error"] | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const record = body as Record<string, unknown>;
  const candidate = record["errorDetail"] ?? record["error"];
  if (typeof candidate !== "object" || candidate === null) return undefined;
  const detail = candidate as Record<string, unknown>;
  if (typeof detail["code"] !== "string" || typeof detail["message"] !== "string") return undefined;
  return detail as unknown as ErrorBody["error"];
}

export class PaymentDecodeError extends Error {
  readonly code = "invalid_payment";
  constructor(message: string) {
    super(message);
    this.name = "PaymentDecodeError";
  }
}

/** Read one header from either a plain bag or a Headers-like object. */
export function getHeader(source: HeaderSource, name: string): string | undefined {
  const maybeHeaders = source as { get?: unknown };
  if (typeof maybeHeaders.get === "function") {
    const value = (source as { get(name: string): string | null | undefined }).get(name);
    return value ?? undefined;
  }
  const bag = source as Record<string, string | string[] | undefined>;
  let value = bag[name];
  if (value === undefined) {
    const lower = name.toLowerCase();
    for (const key of Object.keys(bag)) {
      if (key.toLowerCase() === lower) {
        value = bag[key];
        break;
      }
    }
  }
  if (Array.isArray(value)) return value[0];
  return value ?? undefined;
}

/**
 * Decode the `X-PAYMENT` header. Base64 JSON per x402; a bare JSON object is
 * also accepted because it makes `curl` debugging bearable.
 */
export function decodePaymentHeader(value: string): PaymentPayload {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new PaymentDecodeError("payment header is empty");

  let json: string;
  if (trimmed.startsWith("{")) {
    json = trimmed;
  } else {
    try {
      json = new TextDecoder("utf-8", { fatal: true }).decode(fromBase64(trimmed));
    } catch {
      throw new PaymentDecodeError("payment header is not valid base64 JSON");
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new PaymentDecodeError("payment header did not contain valid JSON");
  }

  return assertPaymentPayload(parsed);
}

function assertPaymentPayload(value: unknown): PaymentPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PaymentDecodeError("payment payload must be a JSON object");
  }
  const candidate = value as Record<string, unknown>;
  const version = candidate["x402Version"];
  const scheme = candidate["scheme"];
  const network = candidate["network"];
  const payload = candidate["payload"];

  if (typeof scheme !== "string" || scheme.length === 0) {
    throw new PaymentDecodeError("payment payload is missing `scheme`");
  }
  if (typeof network !== "string" || network.length === 0) {
    throw new PaymentDecodeError("payment payload is missing `network`");
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new PaymentDecodeError("payment payload is missing `payload`");
  }
  if (version !== undefined && typeof version !== "number") {
    throw new PaymentDecodeError("`x402Version` must be a number");
  }

  return {
    x402Version: (version as number | undefined) ?? X402_VERSION,
    scheme,
    network,
    payload: payload as Record<string, unknown>,
  };
}

/**
 * Best-effort expiry read from a payment payload, unix seconds. The exact
 * scheme carries `authorization.validBefore`; other schemes use `validBefore`
 * or `expiresAt`. Anything we cannot read is left to the facilitator.
 */
export function payloadExpiry(payload: PaymentPayload): number | undefined {
  const body = payload.payload;
  const authorization = body["authorization"];
  const candidates: unknown[] = [
    body["validBefore"],
    body["expiresAt"],
    typeof authorization === "object" && authorization !== null
      ? (authorization as Record<string, unknown>)["validBefore"]
      : undefined,
  ];
  for (const candidate of candidates) {
    const seconds = readUnixSeconds(candidate);
    if (seconds !== undefined) return seconds;
  }
  return undefined;
}

function readUnixSeconds(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return undefined;
}
