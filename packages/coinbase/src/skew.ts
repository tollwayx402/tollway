/**
 * Clock skew measurement.
 *
 * This is where our challenge expiry meets the facilitator's own timestamp
 * validation. If the merchant's clock runs fast, `validBefore` values the payer
 * signs look expired to us; if it runs slow, we accept authorizations the
 * facilitator has already written off. Either way the failure looks like
 * "payments randomly stopped working", which is the worst kind of bug to debug
 * at 3am.
 *
 * `doctor` (§12.3) consumes this. The thresholds below are provisional until
 * measured against real CDP behaviour in the live testnet run.
 */
import { FacilitatorUnreachableError } from "@octroi/core";
import { DEFAULT_FACILITATOR_URL } from "./constants.js";

export interface ClockSkewOptions {
  url?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Injected clock, unix milliseconds. */
  now?: () => number;
}

export interface ClockSkew {
  /** Positive means our clock is ahead of the facilitator's. */
  skewMs: number;
  /** Round-trip time, the uncertainty band on `skewMs`. */
  rttMs: number;
  severity: "ok" | "warn" | "critical";
  advice?: string;
}

/** Provisional: unverified against CDP. See README "watch items". */
export const SKEW_WARN_MS = 5_000;
export const SKEW_CRITICAL_MS = 30_000;

/**
 * Compares local time against the facilitator's `Date` response header.
 *
 * `Date` has one-second resolution, so anything under ~1s is noise. RTT is
 * reported so a caller can tell a genuinely skewed clock from a slow link.
 */
export async function measureClockSkew(options: ClockSkewOptions = {}): Promise<ClockSkew> {
  const url = (options.url ?? DEFAULT_FACILITATOR_URL).replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? (() => Date.now());
  const timeoutMs = options.timeoutMs ?? 5_000;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = now();

  let response: Response;
  try {
    response = await fetchImpl(`${url}/supported`, {
      method: "GET",
      signal: controller.signal,
    });
  } catch (error) {
    throw new FacilitatorUnreachableError(
      `could not reach the facilitator to measure clock skew: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  } finally {
    clearTimeout(timer);
  }

  const finishedAt = now();
  const header = response.headers.get("date");
  if (header === null) {
    throw new FacilitatorUnreachableError(
      "facilitator response carried no Date header, so clock skew cannot be measured",
    );
  }

  const facilitatorMs = Date.parse(header);
  if (Number.isNaN(facilitatorMs)) {
    throw new FacilitatorUnreachableError(`facilitator sent an unparseable Date header: ${header}`);
  }

  const rttMs = finishedAt - startedAt;
  // Compare against the midpoint of the request window: the server stamped its
  // Date somewhere inside it.
  const localMs = startedAt + rttMs / 2;
  const skewMs = Math.round(localMs - facilitatorMs);
  const magnitude = Math.abs(skewMs);

  const severity =
    magnitude >= SKEW_CRITICAL_MS ? "critical" : magnitude >= SKEW_WARN_MS ? "warn" : "ok";

  return {
    skewMs,
    rttMs,
    severity,
    ...(severity === "ok"
      ? {}
      : {
          advice:
            skewMs > 0
              ? "This host's clock is ahead of the facilitator. Payments may be rejected as expired before they truly are. Enable NTP."
              : "This host's clock is behind the facilitator. Authorizations it has already expired may still look valid here. Enable NTP.",
        }),
  };
}
