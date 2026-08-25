// @ts-nocheck
/**
 * Reputation publisher CLI.
 *
 *   npm run publisher:once
 *   npm run publisher
 *
 * Config: PUBLISHER_SECRET, STELLAR_RPC_URL, PUBLISHER_INTERVAL_MS,
 * PUBLISHER_DATA_DIR, PUBLISHER_MAX_INBOX. The verifier id is read from
 * deployments/v1/testnet.json unless REPUTATION_VERIFIER_ID overrides it.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair } from "@stellar/stellar-sdk";
import { StellarReputationAdapter } from "../src/chains/stellar.ts";
import { runPublisherTick, createMetrics } from "../src/engine.ts";
import { FileStore } from "../src/store.ts";
import { numberEnv } from "../src/env.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";

const MAX_INBOX_SIZE = numberEnv("PUBLISHER_MAX_INBOX", 10_000, { min: 1, integer: true });

function loadConfig() {
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, "deployments", "v1", "testnet.json"), "utf8"));
  const verifierId = process.env.REPUTATION_VERIFIER_ID ?? manifest.contracts?.reputationVerifier?.id;
  if (!verifierId) throw new Error("reputationVerifier not deployed (deployments/v1/testnet.json)");

  const secret = process.env.PUBLISHER_SECRET?.trim() ?? process.env.DEPLOYER_SECRET?.trim();
  if (!secret) throw new Error("set PUBLISHER_SECRET (current testnet requires the verifier admin key)");

  return {
    verifierId,
    publisher: Keypair.fromSecret(secret),
    rpcUrl: process.env.STELLAR_RPC_URL ?? manifest.rpcUrl ?? "https://soroban-testnet.stellar.org",
    intervalMs: numberEnv("PUBLISHER_INTERVAL_MS", 15000, { min: 1 }),
    dataDir: process.env.PUBLISHER_DATA_DIR
      ? resolve(process.env.PUBLISHER_DATA_DIR)
      : join(__dirname, "..", "data"),
  };
}

async function tick(cfg, adapter, store, metrics) {
  const res = await runPublisherTick({
    verifierId: cfg.verifierId,
    adapter,
    store,
    dataDir: cfg.dataDir,
  }, metrics);
  const actions = [res.published ? `PUBLISHED ${res.txHash}` : null].filter(Boolean);
  console.log(
    `[${new Date().toISOString()}] leaves=${res.leafCount} (+${res.newlyAccepted}) ` +
      `root=${res.localRoot ? `${res.localRoot.slice(0, 14)}...` : "none"} ` +
      `inbox=${metrics.currentInboxDepth} ` +
      `latency=${res.latencyMs}ms ` +
      (actions.length ? actions.join(" ") : "in-sync"),
  );
  return res;
}

async function main() {
  const once = process.argv.includes("--once");
  const cfg = loadConfig();
  const adapter = new StellarReputationAdapter({
    rpcUrl: cfg.rpcUrl,
    networkPassphrase: NETWORK_PASSPHRASE,
    verifierId: cfg.verifierId,
    publisher: cfg.publisher,
  });
  const store = new FileStore(cfg.dataDir, MAX_INBOX_SIZE);
  const metrics = createMetrics();

  if (once) {
    await tick(cfg, adapter, store, metrics);
    return;
  }

  console.log(`Reputation publisher loop every ${cfg.intervalMs}ms for ${cfg.verifierId} (maxInbox=${MAX_INBOX_SIZE})`);
  // eslint-disable-next-line no-constant-condition
  for (;;) {
    try {
      await tick(cfg, adapter, store, metrics);
    } catch (err) {
      console.error(`tick error: ${err?.message ?? err}`);
    }
    await new Promise((r) => setTimeout(r, cfg.intervalMs));
  }
}

main().catch((err) => {
  console.error(err?.message ?? err);
  process.exit(1);
});
