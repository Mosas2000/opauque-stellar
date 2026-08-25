// @ts-nocheck
/**
 * Minimal reputation publisher HTTP API.
 *
 * POST   /v1/reputation/leaves
 * GET    /v1/reputation/root/:leaf
 * GET    /v1/reputation/snapshot/:verifierId
 * GET    /metrics  (Prometheus exposition format)
 * GET    /health
 *
 * `POST /v1/reputation/leaves` only queues the commitment into the durable inbox and
 * acknowledges immediately (202). Publication — the on-chain Soroban round trip — runs on
 * a background tick loop at PUBLISHER_INTERVAL_MS, independent of any single request, with
 * retry on the next interval if a tick fails. Submitters confirm inclusion once the
 * background loop publishes via GET /v1/reputation/root/:leaf or /snapshot/:verifierId.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair } from "@stellar/stellar-sdk";
import { StellarReputationAdapter } from "../src/chains/stellar.ts";
import { createMetrics } from "../src/engine.ts";
import { FileStore } from "../src/store.ts";
import { createRateLimiterFromEnv } from "../src/rate-limit.ts";
import { createPublisherHttpServer, runPublisherLoop } from "../src/http.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";

const MAX_INBOX_SIZE = Number(process.env.PUBLISHER_MAX_INBOX ?? 10_000);
const MAX_BODY_BYTES = Number(process.env.PUBLISHER_MAX_BODY_BYTES ?? 32 * 1024);

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
    dataDir: process.env.PUBLISHER_DATA_DIR
      ? resolve(process.env.PUBLISHER_DATA_DIR)
      : join(__dirname, "..", "data"),
    host: process.env.PUBLISHER_HTTP_HOST ?? "127.0.0.1",
    port: Number(process.env.PUBLISHER_HTTP_PORT ?? 8790),
    corsOrigin: process.env.PUBLISHER_CORS_ORIGIN ?? "*",
    intervalMs: Number(process.env.PUBLISHER_INTERVAL_MS ?? 15000),
  };
}

async function main() {
  const cfg = loadConfig();
  const store = new FileStore(cfg.dataDir, MAX_INBOX_SIZE);
  const metrics = createMetrics();
  const adapter = new StellarReputationAdapter({
    rpcUrl: cfg.rpcUrl,
    networkPassphrase: NETWORK_PASSPHRASE,
    verifierId: cfg.verifierId,
    publisher: cfg.publisher,
  });
  const rateLimiter = createRateLimiterFromEnv();

  runPublisherLoop({
    verifierId: cfg.verifierId,
    adapter,
    store,
    metrics,
    dataDir: cfg.dataDir,
    intervalMs: cfg.intervalMs,
    onTick: (res) => {
      if (!res.published) return;
      console.log(`[${new Date().toISOString()}] PUBLISHED root=${res.localRoot?.slice(0, 14)}... tx=${res.txHash}`);
    },
    onError: (err) => {
      console.error(`background publish tick failed (will retry): ${err?.message ?? err}`);
    },
  }).catch((err) => {
    console.error(`publish loop crashed: ${err?.message ?? err}`);
    process.exit(1);
  });

  const server = createPublisherHttpServer({
    verifierId: cfg.verifierId,
    store,
    metrics,
    rateLimiter,
    dataDir: cfg.dataDir,
    corsOrigin: cfg.corsOrigin,
    maxBodyBytes: MAX_BODY_BYTES,
  });

  server.listen(cfg.port, cfg.host, () => {
    console.log(`Reputation publisher API listening on http://${cfg.host}:${cfg.port}`);
    console.log(`verifier=${cfg.verifierId} maxInbox=${MAX_INBOX_SIZE} publishIntervalMs=${cfg.intervalMs}`);
  });
}

main().catch((err) => {
  console.error(err?.message ?? err);
  process.exit(1);
});

