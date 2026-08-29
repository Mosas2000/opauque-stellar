/**
 * `@opaquecash/stellar` — stealth private payments, privacy pools, relayer-market
 * submission, and on-chain ZK reputation for Stellar / Soroban.
 *
 * The high-level `OpaqueClient` and chain services are layered on top of the
 * isomorphic crypto primitives re-exported here. Import a narrower surface via
 * subpaths (e.g. `@opaquecash/stellar/crypto`) for the smallest bundle.
 */

/** Replaced at build time with the package.json version (see tsup.config.ts). */
declare const __SDK_VERSION__: string | undefined;

/** The installed SDK version. */
export const VERSION: string =
  typeof __SDK_VERSION__ === "string" ? __SDK_VERSION__ : "0.0.0-dev";

export * from "./crypto/index";
export * from "./errors/index";
export * from "./config/index";
export * from "./signer/index";
export * from "./logger/index";
export * from "./telemetry/index";
export * from "./rpc/index";
export * from "./contracts/index";
export * from "./storage/index";
export * from "./artifacts/index";
export * from "./scanner/index";
export * from "./prove/index";
export * from "./relayer-protocol/index";
export * from "./services/index";
export * from "./client/index";
