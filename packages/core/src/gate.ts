import { canonicalJson } from "./canonical.js";
import { randomBytes, sha256Hex, toHex, utf8 } from "./bytes.js";
import {
  PAYMENT_HEADER,
  PaymentDecodeError,
  RECEIPT_HEADER,
  buildChallengeBody,
  decodePaymentHeader,
  getHeader,
  payloadExpiry,
} from "./challenge.js";
import { EventBus, type EventSink } from "./events.js";
import {
  FacilitatorUnreachableError,
  TollwayConfigError,
  errorBody,
  rejectMessage,
} from "./errors.js";
import { adapterForNetwork, resolveFacilitator, type FacilitatorSpec } from "./facilitator.js";
import { silentLogger } from "./logger.js";
import { MemoryNonceStore, type NonceStore } from "./nonce.js";
import { assetDecimals, formatAtomic, parsePrice, resolvePrice } from "./price.js";
import {
  createEphemeralSigner,
  signReceipt,
  type Receipt,
  type Signer,
  type UnsignedReceipt,
} from "./receipts.js";
import type {
  Asset,
  ChallengeRequest,
  ChallengeScheme,
  FacilitatorAdapter,
  GateRequest,
  Logger,
  Mode,
  Network,
  PaymentPayload,
  PriceConfig,
  RejectCode,
  VerifyResult,
} from "./types.js";

const DEFAULT_EXPIRY_SECONDS = 120;
const DEFAULT_VERIFY_TIMEOUT_MS = 8_000;
const DEFAULT_REPLAY_TTL_MS = 15 * 60 * 1_000;

export interface GateOptions {
  /** USD string, atomic bigint, or a per-request resolver (§3.1). */
  price: PriceConfig;
  asset?: Asset;
  /** Override decimals for an asset the SDK does not know. */
  decimals?: number;
  /** Single network, or an ordered fallback list advertised in one challenge. */
  network: Network | Network[];
  /** Settlement address. Required standalone; the SDK never holds funds (§1.4). */
  payTo: string;
  facilitator: FacilitatorSpec | FacilitatorSpec[];
  /** §1.3 — default fail_closed. */
  mode?: Mode;
  /** Account id in cloud mode; receipts and events carry it. */
  merchant?: string | null;
  /** Route label when the adapter cannot supply one per request. */
  route?: string;
  /**
   * Origin used to absolutize the x402 `resource` when the adapter cannot give
   * a full URL (e.g. `https://api.example.com`). x402 requires an absolute URL
   * there, so without this a path-only request is a hard error rather than a
   * challenge the agent's client will reject.
   */
  resourceBase?: string;
  description?: string;
  mimeType?: string;
  /** Challenge lifetime, seconds. Default 120. */
  expirySeconds?: number;
  /** How long to wait on a facilitator before applying `mode`. Default 8s. */
  verifyTimeoutMs?: number;
  /** How long consumed payment payloads stay remembered. Default 15m. */
  replayTtlMs?: number;
  nonceStore?: NonceStore;
  /** Standalone mode generates an ephemeral Ed25519 key when omitted. */
  signer?: Signer | Promise<Signer>;
  /** Local sink, always called (§3.1). */
  onEvent?: EventSink;
  /** Additional sinks — the cloud ingest client attaches here. */
  sinks?: EventSink[];
  logger?: Logger;
  /** Injected clock, unix milliseconds. Tests and golden files depend on this. */
  clock?: () => number;
  newNonce?: () => string;
  newId?: (prefix: string) => string;
}

export interface GatePass {
  type: "pass";
  /** null when `fail_open` let an unpaid request through. */
  receipt: Receipt | null;
  receiptId: string | null;
  payer: string | null;
  headers: Record<string, string>;
  /** Call once the downstream handler has produced a status (§7). */
  report(outcome: { status: number; latencyMs?: number; error?: unknown }): void;
}

export interface GateHalt {
  type: "challenge" | "reject" | "error";
  status: number;
  headers: Record<string, string>;
  body: unknown;
  code: string;
}

export type GateResult = GatePass | GateHalt;

/** Everything the pipeline resolves once per request, then passes around. */
interface RequestContext {
  req: GateRequest;
  route: string;
  /** Absolute URL for the x402 `resource` field. */
  resource: string;
  /** Price in atomic units. */
  amount: bigint;
  startedAt: number;
}

const JSON_HEADERS: Record<string, string> = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

/**
 * The protocol core (§4). Framework adapters do three things: map their
 * request onto {@link GateRequest}, render a {@link GateHalt}, and call
 * {@link GatePass.report} after the handler runs.
 */
export class Gate {
  readonly events: EventBus;
  readonly mode: Mode;
  readonly networks: Network[];
  readonly asset: Asset;

  readonly #options: GateOptions;
  readonly #adapters: FacilitatorAdapter[];
  readonly #payTo: string;
  readonly #decimals: number;
  readonly #merchant: string | null;
  readonly #expirySeconds: number;
  readonly #verifyTimeoutMs: number;
  readonly #replayTtlMs: number;
  readonly #nonces: NonceStore;
  readonly #logger: Logger;
  readonly #clock: () => number;
  readonly #newNonce: () => string;
  readonly #newId: (prefix: string) => string;
  readonly #resourceBase: string | undefined;
  #signer: Signer | Promise<Signer> | undefined;

  constructor(options: GateOptions) {
    this.#options = options;
    this.#logger = options.logger ?? silentLogger;
    this.#clock = options.clock ?? (() => Date.now());
    this.#newNonce = options.newNonce ?? (() => toHex(randomBytes(16)));
    this.#newId = options.newId ?? ((prefix) => `twy_${prefix}_${toHex(randomBytes(12))}`);

    this.asset = options.asset ?? "usdc";
    this.#decimals = assetDecimals(this.asset, options.decimals);

    this.networks = Array.isArray(options.network) ? [...options.network] : [options.network];
    if (this.networks.length === 0) {
      throw new TollwayConfigError("at least one network is required");
    }

    const specs = Array.isArray(options.facilitator) ? options.facilitator : [options.facilitator];
    if (specs.length === 0) throw new TollwayConfigError("a facilitator is required");
    this.#adapters = specs.map(resolveFacilitator);

    for (const network of this.networks) {
      if (!adapterForNetwork(this.#adapters, network)) {
        throw new TollwayConfigError(
          `no configured facilitator supports network "${network}" ` +
            `(have: ${this.#adapters.map((a) => `${a.id}[${a.networks.join(",")}]`).join(", ")})`,
        );
      }
    }

    if (typeof options.payTo !== "string" || options.payTo.trim().length === 0) {
      throw new TollwayConfigError("`payTo` is required — the SDK never holds funds (§1.4)");
    }
    this.#payTo = options.payTo;

    if (options.resourceBase !== undefined && !isAbsoluteUrl(options.resourceBase)) {
      throw new TollwayConfigError(
        `resourceBase must be an absolute URL, got "${options.resourceBase}"`,
      );
    }
    this.#resourceBase = options.resourceBase;

    this.mode = options.mode ?? "fail_closed";
    if (this.mode !== "fail_closed" && this.mode !== "fail_open") {
      throw new TollwayConfigError(`mode must be "fail_closed" or "fail_open", got "${this.mode}"`);
    }

    // Catch a mistyped static price at boot rather than on the first request.
    if (typeof options.price !== "function") {
      parsePrice(options.price, { asset: this.asset, decimals: this.#decimals });
    }

    this.#merchant = options.merchant ?? null;
    this.#expirySeconds = options.expirySeconds ?? DEFAULT_EXPIRY_SECONDS;
    this.#verifyTimeoutMs = options.verifyTimeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS;
    this.#replayTtlMs = options.replayTtlMs ?? DEFAULT_REPLAY_TTL_MS;

    // A payment can be presented at any point in the challenge window, so
    // forgetting it sooner than that window closes is an open replay hole.
    if (this.#replayTtlMs < this.#expirySeconds * 1_000) {
      throw new TollwayConfigError(
        `replayTtlMs (${this.#replayTtlMs}) must be at least the challenge window ` +
          `(expirySeconds ${this.#expirySeconds} = ${this.#expirySeconds * 1_000}ms), ` +
          `or a payment could be replayed after the store forgets it but before it expires`,
      );
    }
    this.#nonces = options.nonceStore ?? new MemoryNonceStore({ clock: this.#clock });
    this.#signer = options.signer;

    const sinks: EventSink[] = [];
    if (options.onEvent) sinks.push(options.onEvent);
    if (options.sinks) sinks.push(...options.sinks);
    this.events = new EventBus({
      sinks,
      merchant: this.#merchant,
      logger: this.#logger,
      clock: this.#clock,
      newId: () => this.#newId("evt"),
    });
  }

  /** Run the protocol for one request (§4). Never throws for payer-side faults. */
  async handle(req: GateRequest): Promise<GateResult> {
    const startedAt = this.#clock();
    const route = req.route || this.#options.route || req.path || "/";

    let amount: bigint;
    try {
      amount = await resolvePrice(this.#options.price, req, {
        asset: this.asset,
        decimals: this.#decimals,
      });
    } catch (error) {
      // A broken price is a merchant bug, not a facilitator outage, so `mode`
      // does not apply: we never serve a route we cannot price.
      const message = error instanceof Error ? error.message : String(error);
      this.events.emit("gate.error", route, { code: "invalid_config", message, mode: "fail_closed" });
      this.#logger.error("tollway: could not resolve price", { route, error: message });
      return {
        type: "error",
        status: 500,
        headers: { ...JSON_HEADERS },
        body: errorBody("invalid_config", "Route price could not be resolved."),
        code: "invalid_config",
      };
    }

    // x402 requires an absolute URL for `resource`. Failing loudly here beats
    // shipping a challenge the agent's client library will reject — that error
    // surfaces in someone else's process, where we cannot see it.
    let resource: string;
    try {
      resource = this.#resolveResource(req, route);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.events.emit("gate.error", route, {
        code: "invalid_resource",
        message,
        mode: "fail_closed",
      });
      this.#logger.error("tollway: could not build an absolute resource URL", {
        route,
        error: message,
      });
      return {
        type: "error",
        status: 500,
        headers: { ...JSON_HEADERS },
        body: errorBody("invalid_resource", message),
        code: "invalid_resource",
      };
    }

    const ctx: RequestContext = { req, route, resource, amount, startedAt };

    const header = getHeader(req.headers, PAYMENT_HEADER);
    if (header === undefined) {
      return this.#issueChallenge(ctx);
    }

    let payment: PaymentPayload;
    try {
      payment = decodePaymentHeader(header);
    } catch (error) {
      const message = error instanceof PaymentDecodeError ? error.message : "Malformed payment.";
      return this.#reject(ctx, "invalid_payment", message);
    }

    return this.#verifyAndPass(ctx, payment);
  }

  /** Await queued event delivery. For tests and graceful shutdown. */
  async flushEvents(): Promise<void> {
    await this.events.flush();
  }

  /** Raw Ed25519 public key that receipts from this gate are signed with. */
  async publicKey(): Promise<Uint8Array> {
    return (await this.#resolveSigner()).publicKey();
  }

  // --- challenge ----------------------------------------------------------

  #issueChallenge(ctx: RequestContext): GateHalt {
    const { route, amount } = ctx;
    const built = this.#buildAccepts(ctx);
    if (built === undefined) {
      return {
        type: "error",
        status: 500,
        headers: { ...JSON_HEADERS },
        body: errorBody("no_scheme_available", "No facilitator could price this route."),
        code: "no_scheme_available",
      };
    }

    this.events.emit("challenge.issued", route, {
      price: amount.toString(),
      asset: this.asset,
      networks: built.accepts.map((scheme) => scheme.network),
      nonce: built.nonce,
      expires_at: built.expiresAt,
    });

    return {
      type: "challenge",
      status: 402,
      headers: { ...JSON_HEADERS },
      body: buildChallengeBody(
        built.accepts,
        "payment_required",
        `This route costs ${formatAtomic(amount, this.#decimals)} ${this.asset.toUpperCase()}.`,
      ),
      code: "payment_required",
    };
  }

  #buildAccepts(
    ctx: RequestContext,
    nonce = this.#newNonce(),
  ): { accepts: ChallengeScheme[]; requirements: Map<Network, ChallengeRequest>; nonce: string; expiresAt: number } | undefined {
    const { req, route, amount, resource } = ctx;
    const expiresAt = Math.floor(this.#clock() / 1_000) + this.#expirySeconds;
    const accepts: ChallengeScheme[] = [];
    const requirements = new Map<Network, ChallengeRequest>();

    for (const network of this.networks) {
      const adapter = adapterForNetwork(this.#adapters, network);
      if (!adapter) continue;
      const requirement: ChallengeRequest = {
        route,
        resource,
        description: this.#options.description ?? `Access to ${route}`,
        mimeType: this.#options.mimeType ?? "application/json",
        network,
        asset: this.asset,
        amount,
        payTo: this.#payTo,
        nonce,
        expiresAt,
        maxTimeoutSeconds: this.#expirySeconds,
      };
      try {
        accepts.push(adapter.buildChallenge(requirement));
        requirements.set(network, requirement);
      } catch (error) {
        // One network failing to price should not take the others down.
        this.#logger.warn("tollway: facilitator could not build a challenge", {
          route,
          network,
          facilitator: adapter.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (accepts.length === 0) return undefined;
    return { accepts, requirements, nonce, expiresAt };
  }

  // --- verify -------------------------------------------------------------

  async #verifyAndPass(ctx: RequestContext, payment: PaymentPayload): Promise<GateResult> {
    const { route, amount } = ctx;
    if (!this.networks.includes(payment.network)) {
      return this.#reject(ctx, "wrong_network",
        `This route accepts ${this.networks.join(", ")}, payment was on "${payment.network}".`,
      );
    }

    const adapter = adapterForNetwork(this.#adapters, payment.network);
    if (!adapter) {
      return this.#reject(ctx, "wrong_network", rejectMessage("wrong_network"));
    }

    // Rebuild the requirements for the paid network. They are a pure function
    // of (route, price, payTo, expiry), so they reconstruct exactly — except
    // the nonce, which we re-bind to whatever the payer echoed.
    const echoedNonce = readNonce(payment);
    const built = this.#buildAccepts(ctx, echoedNonce ?? this.#newNonce());
    const requirement = built?.requirements.get(payment.network);
    const scheme = built?.accepts.find((entry) => entry.network === payment.network);
    if (!built || !requirement || !scheme) {
      this.events.emit("gate.error", route, {
        code: "no_scheme_available",
        network: payment.network,
        mode: "fail_closed",
      });
      return {
        type: "error",
        status: 500,
        headers: { ...JSON_HEADERS },
        body: errorBody("no_scheme_available", "No facilitator could price this route."),
        code: "no_scheme_available",
      };
    }

    const nowMs = this.#clock();
    const expiry = payloadExpiry(payment);
    if (expiry !== undefined && expiry * 1_000 <= nowMs) {
      return this.#reject(ctx, "expired", rejectMessage("expired"));
    }

    const replayKey = await paymentReplayKey(payment);
    if (await this.#nonces.has(replayKey)) {
      return this.#reject(ctx, "replay", rejectMessage("replay"));
    }

    let result: VerifyResult;
    try {
      result = await this.#verifyWithTimeout(adapter, payment, {
        scheme,
        requirements: requirement,
        route,
        now: nowMs,
        logger: this.#logger,
      });
    } catch (error) {
      return this.#facilitatorDown(route, adapter, error, ctx.startedAt);
    }

    if (!result.ok) {
      return this.#reject(ctx, result.code,
        result.message ?? rejectMessage(result.code),
        adapter.id,
      );
    }

    const settled = toBigInt(result.settledAmount);
    if (settled === undefined || settled < amount) {
      return this.#reject(ctx, "wrong_amount",
        `Route costs ${amount.toString()} atomic units, settled ${String(result.settledAmount)}.`,
        adapter.id,
      );
    }

    // Consume last: a payload that failed verification stays retriable, one
    // that succeeded is burned for both its own hash and its on-chain ref.
    if (!(await this.#nonces.consume(replayKey, this.#replayTtlMs))) {
      return this.#reject(ctx, "replay", rejectMessage("replay"), adapter.id);
    }
    const txKey = `tx:${payment.network}:${result.txRef}`;
    if (!(await this.#nonces.consume(txKey, this.#replayTtlMs))) {
      return this.#reject(ctx, "replay", rejectMessage("replay"), adapter.id);
    }

    const receipt = await this.#mintReceipt(route, payment.network, settled, result);
    this.events.emit("toll.settled", route, { receipt });

    return this.#pass(route, receipt, ctx.startedAt);
  }

  async #verifyWithTimeout(
    adapter: FacilitatorAdapter,
    payment: PaymentPayload,
    ctx: Omit<Parameters<FacilitatorAdapter["verify"]>[1], "signal">,
  ): Promise<VerifyResult> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = new FacilitatorUnreachableError(
          `facilitator "${adapter.id}" did not answer within ${this.#verifyTimeoutMs}ms`,
          { facilitator: adapter.id },
        );
        controller.abort(error);
        reject(error);
      }, this.#verifyTimeoutMs);
    });

    try {
      return await Promise.race([
        adapter.verify(payment, { ...ctx, signal: controller.signal }),
        timeout,
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  // --- outcomes -----------------------------------------------------------

  #pass(route: string, receipt: Receipt | null, startedAt: number): GatePass {
    let reported = false;
    const headers: Record<string, string> = receipt ? { [RECEIPT_HEADER]: receipt.id } : {};
    return {
      type: "pass",
      receipt,
      receiptId: receipt?.id ?? null,
      payer: receipt?.payer ?? null,
      headers,
      report: (outcome) => {
        if (reported) return;
        reported = true;
        const latencyMs = outcome.latencyMs ?? this.#clock() - startedAt;
        const failed = outcome.status >= 500 || outcome.error !== undefined;
        if (failed) {
          this.events.emit("request.failed", route, {
            receipt_id: receipt?.id ?? null,
            status: outcome.status,
            latency_ms: latencyMs,
          });
        } else {
          this.events.emit("request.served", route, {
            receipt_id: receipt?.id ?? null,
            latency_ms: latencyMs,
            status: outcome.status,
          });
        }
      },
    };
  }

  #reject(
    ctx: RequestContext,
    code: RejectCode,
    message: string,
    facilitator?: string,
  ): GateHalt {
    const { route } = ctx;
    this.events.emit("toll.rejected", route, {
      code,
      message,
      ...(facilitator === undefined ? {} : { facilitator }),
    });

    // Re-advertise so the agent can retry immediately. This is not counted as
    // a new `challenge.issued` — see PROTOCOL.md "Event accounting".
    const built = this.#buildAccepts(ctx);
    return {
      type: "reject",
      status: 402,
      headers: { ...JSON_HEADERS },
      body: buildChallengeBody(built?.accepts ?? [], code, message),
      code,
    };
  }

  #facilitatorDown(
    route: string,
    adapter: FacilitatorAdapter,
    error: unknown,
    startedAt: number,
  ): GateResult {
    const message = error instanceof Error ? error.message : String(error);
    this.events.emit("gate.error", route, {
      code: "facilitator_unreachable",
      facilitator: adapter.id,
      message,
      mode: this.mode,
    });
    this.#logger.error("tollway: facilitator unreachable", {
      route,
      facilitator: adapter.id,
      mode: this.mode,
      error: message,
    });

    if (this.mode === "fail_open") {
      // Explicit merchant choice (§1.3): serve unpaid, with no receipt to imply
      // otherwise.
      return this.#pass(route, null, startedAt);
    }

    return {
      type: "error",
      status: 503,
      headers: { ...JSON_HEADERS, "retry-after": "5" },
      body: errorBody(
        "facilitator_unreachable",
        "Payment facilitator is unavailable; the request was not served.",
      ),
      code: "facilitator_unreachable",
    };
  }

  async #mintReceipt(
    route: string,
    network: Network,
    settled: bigint,
    result: Extract<VerifyResult, { ok: true }>,
  ): Promise<Receipt> {
    const unsigned: UnsignedReceipt = {
      id: this.#newId("rcpt"),
      v: 1,
      route,
      amount: settled.toString(),
      asset: this.asset,
      network,
      payer: result.payer,
      tx_ref: result.txRef,
      ts: Math.floor(this.#clock() / 1_000),
      merchant: this.#merchant,
    };
    return signReceipt(unsigned, await this.#resolveSigner());
  }

  /**
   * x402 `resource` must be an absolute URL. Adapters that know their origin
   * pass `req.url`; everyone else configures `resourceBase`. A bare path is an
   * error here rather than an invalid challenge on the wire.
   */
  #resolveResource(req: GateRequest, route: string): string {
    const candidate = req.url ?? req.path ?? route;
    if (isAbsoluteUrl(candidate)) return candidate;
    if (this.#resourceBase !== undefined) {
      return new URL(candidate, this.#resourceBase).toString();
    }
    throw new TollwayConfigError(
      `x402 requires an absolute URL for \`resource\`, but this request only supplied "${candidate}". ` +
        "Pass `req.url` from the adapter, or set `resourceBase` on the gate.",
    );
  }

  async #resolveSigner(): Promise<Signer> {
    if (this.#signer === undefined) this.#signer = createEphemeralSigner();
    const signer = await this.#signer;
    this.#signer = signer;
    return signer;
  }
}

export function createGate(options: GateOptions): Gate {
  return new Gate(options);
}

/**
 * Replay identity of a payment payload: the hash of its canonical form. This
 * needs no cooperation from the facilitator and works the same standalone,
 * single-instance and behind a shared Redis store.
 */
export async function paymentReplayKey(payment: PaymentPayload): Promise<string> {
  const canonical = canonicalJson({
    scheme: payment.scheme,
    network: payment.network,
    payload: payment.payload,
  });
  return `pay:${await sha256Hex(utf8(canonical))}`;
}

function readNonce(payment: PaymentPayload): string | undefined {
  const body = payment.payload;
  const direct = body["nonce"];
  if (typeof direct === "string" && direct.length > 0) return direct;
  const extra = body["extra"];
  if (typeof extra === "object" && extra !== null) {
    const nested = (extra as Record<string, unknown>)["nonce"];
    if (typeof nested === "string" && nested.length > 0) return nested;
  }
  return undefined;
}

function isAbsoluteUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function toBigInt(value: bigint | string): bigint | undefined {
  if (typeof value === "bigint") return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return BigInt(value.trim());
  return undefined;
}
