/**
 * `@tollway/gate` — the batteries-included entry point.
 *
 * One install gives you the protocol core, the Express binding, and the
 * Coinbase facilitator. Reach for the individual packages when you want a
 * different framework or facilitator; nothing here is required.
 */
export * from "@tollway/core";
export { tollway } from "@tollway/express";
export type { TollwayExpressOptions, TollwayMiddleware } from "@tollway/express";
export {
  CDP_FACILITATOR_URL,
  DEFAULT_FACILITATOR_URL,
  coinbaseFacilitator,
  measureClockSkew,
  registerCoinbaseFacilitator,
} from "@tollway/coinbase";
export type { ClockSkew, CoinbaseFacilitatorOptions } from "@tollway/coinbase";
export { doctor, formatReport } from "./doctor.js";
export type { DoctorOptions, DoctorReport } from "./doctor.js";
