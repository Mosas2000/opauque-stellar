// @ts-nocheck
/**
 * ASP indexer CLI.
 *   npm run indexer:once   — single reconcile pass (used by the headless smoke)
 *   npm run indexer        — loop every ASP_INTERVAL_MS
 *
 * Config (env / .env): STELLAR_RPC_URL, ASP_SECRET (S... authority seed), ASP_INTERVAL_MS,
 * ASP_CONFIRMATIONS, ASP_MAX_ROOT_AGE_MS, optional IPFS_API_URL. Pool id + scope are
 * resolved from deployments/v1/testnet.json. Never run in CI (it sends live transactions).
 *
 * A `PublicationMonitor` (src/monitor.ts) and `ReorgGuard` (src/reorg-guard.ts) are wired
 * into every tick: the monitor alerts when the published root goes stale, and the guard
 * halts publication on a ledger continuity break instead of baking a suspect root into the
 * manifest.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair } from "@stellar/stellar-sdk";
import { StellarChainAdapter } from "../src/chains/stellar.ts";
import { FileStore } from "../src/store.ts";
import { approveAll } from "../src/policy.ts";
import { runPoolTick } from "../src/engine.ts";
import { PublicationMonitor } from "../src/monitor.ts";
import { ReorgGuard } from "../src/reorg-guard.ts";
import { recordTickFailure, recordTickSuccess } from "../src/metrics.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";

/** Default: 8x the default tick interval, generous enough to tolerate transient RPC lag. */
const DEFAULT_MAX_ROOT_AGE_MS = 120_000;

export function loadConfig() {
  const manifest = JSON.parse(
    readFileSync(join(REPO_ROOT, "deployments", "v1", "testnet.json"), "utf8"),
  );
  const poolId = manifest.contracts?.privacyPool?.id;
  const scope = manifest.wiring?.privacyPool?.scope ?? 1;
  if (!poolId) throw new Error("privacyPool not deployed (deployments/v1/testnet.json)");

  const secret = process.env.ASP_SECRET?.trim();
  if (!secret) throw new Error("set ASP_SECRET (the ASP authority S... seed)");

  return {
    poolId,
    scope,
    authority: Keypair.fromSecret(secret),
    rpcUrl: process.env.STELLAR_RPC_URL ?? manifest.rpcUrl ?? "https://soroban-testnet.stellar.org",
    deploymentLedger: manifest.deploymentLedger ?? undefined,
    intervalMs: Number(process.env.ASP_INTERVAL_MS ?? 15000),
    confirmations: Number(process.env.ASP_CONFIRMATIONS ?? 1),
    maxRootAgeMs: Number(process.env.ASP_MAX_ROOT_AGE_MS ?? DEFAULT_MAX_ROOT_AGE_MS),
    dataDir: join(__dirname, "..", "data"),
  };
}

/** Alerts (via stderr) when the last published root exceeds `cfg.maxRootAgeMs`. */
export function createPublicationMonitor(cfg, overrides = {}) {
  return new PublicationMonitor({
    maxRootAgeMs: cfg.maxRootAgeMs,
    onAlert: (alert) => {
      console.error(`[ALERT] ${alert.message}`);
    },
    ...overrides,
  });
}

/** Halts publication (via the engine) and logs when ledger continuity breaks. */
export function createReorgGuard(overrides = {}) {
  return new ReorgGuard({
    onDivergence: (event) => {
      console.error(`[REORG] ${event.message}`);
    },
    ...overrides,
  });
}

export async function tick(cfg, adapter, store, monitor, guard, metrics = undefined) {
  const tickStart = Date.now();
  let res;
  try {
    res = await runPoolTick({
      poolId: cfg.poolId,
      scope: cfg.scope,
      adapter,
      store,
      policy: approveAll,
      dataDir: cfg.dataDir,
      confirmations: cfg.confirmations,
      publicationMonitor: monitor,
      reorgGuard: guard,
    });
  } catch (err) {
    if (metrics) recordTickFailure(metrics, err, Date.now() - tickStart);
    throw err;
  }
  if (metrics) recordTickSuccess(metrics, res, Date.now() - tickStart);
  const when = new Date().toISOString();
  const actions = [
    res.published ? "ASP_PUBLISHED" : null,
    res.statePublished ? "STATE_PUBLISHED" : null,
    res.haltedForReorg ? "HALTED_FOR_REORG" : null,
  ].filter(Boolean);
  console.log(
    `[${when}] approved=${res.approvedCount} (+${res.newlyApproved}) ` +
      `asp=${res.localRoot.slice(0, 14)}… stateLeaves=${res.stateLeafCount ?? "n/a"} ` +
      (actions.length > 0 ? actions.join(" ") : "in-sync"),
  );
  return res;
}

async function main() {
  const once = process.argv.includes("--once");
  const cfg = loadConfig();
  const adapter = new StellarChainAdapter({
    rpcUrl: cfg.rpcUrl,
    networkPassphrase: NETWORK_PASSPHRASE,
    poolId: cfg.poolId,
    scope: cfg.scope,
    authority: cfg.authority,
    deploymentLedger: cfg.deploymentLedger,
    confirmations: cfg.confirmations,
  });
  const store = new FileStore(cfg.dataDir);
  const monitor = createPublicationMonitor(cfg);
  const guard = createReorgGuard();

  if (once) {
    await tick(cfg, adapter, store, monitor, guard);
    return;
  }
  console.log(
    `ASP indexer loop every ${cfg.intervalMs}ms for pool ${cfg.poolId} ` +
      `(maxRootAgeMs=${cfg.maxRootAgeMs})`,
  );
  // eslint-disable-next-line no-constant-condition
  for (;;) {
    try {
      await tick(cfg, adapter, store, monitor, guard);
    } catch (e) {
      console.error(`tick error: ${e?.message ?? e}`);
    }
    await new Promise((r) => setTimeout(r, cfg.intervalMs));
  }
}

// Only auto-run when executed directly (`npm run indexer[:once]`), not when imported by tests.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(e?.message ?? e);
    process.exit(1);
  });
}
