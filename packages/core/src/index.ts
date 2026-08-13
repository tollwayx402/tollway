/**
 * @tollway/core — the protocol core (§4). Framework-agnostic by construction:
 * nothing in this package imports a server, a chain client, or the cloud.
 */

export { Gate, createGate, paymentReplayKey } from "./gate.js";
export type { GateOptions, GateResult, GatePass, GateHalt } from "./gate.js";

export {
  X402_VERSION,
  X402_ERROR_REASONS,
  x402ErrorReason,
  PAYMENT_HEADER,
  RECEIPT_HEADER,
  PaymentDecodeError,
  buildChallengeBody,
  decodePaymentHeader,
  getHeader,
  payloadExpiry,
  readErrorDetail,
} from "./challenge.js";
export type { ChallengeBody } from "./challenge.js";

export {
  adapterForNetwork,
  getFacilitator,
  registerFacilitator,
  registeredFacilitators,
  resolveFacilitator,
} from "./facilitator.js";
export type { FacilitatorSpec } from "./facilitator.js";

export { EventBus } from "./events.js";
export type { EventBusOptions, EventSink, EventType, TollwayEvent } from "./events.js";

export {
  createEphemeralSigner,
  createSignerFromJwk,
  documentSigningBytes,
  documentSigningPayload,
  publicKeyHex,
  receiptSigningBytes,
  receiptSigningPayload,
  signDocument,
  signReceipt,
  verifyDocument,
  verifyReceipt,
} from "./receipts.js";
export type { Receipt, Signer, SignedDocument, UnsignedReceipt } from "./receipts.js";

export { MemoryNonceStore } from "./nonce.js";

export { MemoryRateLimitStore, isDenied, payerHint } from "./ratelimit.js";
export type {
  Denylist,
  MemoryRateLimitStoreOptions,
  RateLimitOptions,
  RateLimitStore,
} from "./ratelimit.js";
export type { MemoryNonceStoreOptions, NonceStore } from "./nonce.js";

export { ASSET_DECIMALS, assetDecimals, formatAtomic, parsePrice, resolvePrice } from "./price.js";

export { canonicalBytes, canonicalJson } from "./canonical.js";

export {
  CanonicalJsonError,
  DOC_BASE,
  FacilitatorUnreachableError,
  TollwayConfigError,
  errorBody,
  rejectMessage,
} from "./errors.js";
export type { ErrorBody } from "./errors.js";

export { consoleLogger, silentLogger } from "./logger.js";

export { formatConformance, runFacilitatorConformance } from "./conformance.js";
export type { ConformanceCheck, ConformanceOptions } from "./conformance.js";

export type {
  Asset,
  ChallengeRequest,
  ChallengeScheme,
  FacilitatorAdapter,
  GateRequest,
  HeaderSource,
  Logger,
  Mode,
  Network,
  PaymentPayload,
  Price,
  PriceConfig,
  PriceResolver,
  RejectCode,
  VerifyContext,
  VerifyResult,
} from "./types.js";
