/**
 * `@octroi/gate` — the batteries-included entry point.
 *
 * One install gives you the protocol core, the Express binding, and the
 * Coinbase facilitator. Reach for the individual packages when you want a
 * different framework or facilitator; nothing here is required.
 */
export * from "@octroi/core";
export { octroi } from "@octroi/express";
export type { OctroiExpressOptions, OctroiMiddleware } from "@octroi/express";
export {
  CDP_FACILITATOR_URL,
  DEFAULT_FACILITATOR_URL,
  coinbaseFacilitator,
  measureClockSkew,
  registerCoinbaseFacilitator,
} from "@octroi/coinbase";
export type { ClockSkew, CoinbaseFacilitatorOptions } from "@octroi/coinbase";
export { doctor, formatReport } from "./doctor.js";
export type { DoctorOptions, DoctorReport } from "./doctor.js";
