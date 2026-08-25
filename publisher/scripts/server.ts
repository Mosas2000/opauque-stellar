// @ts-nocheck
/**
 * Minimal reputation publisher HTTP API.
 *
 * POST   /v1/reputation/leaves        - requires Bearer token in PUBLISHER_SUBMIT_TOKENS
 * GET    /v1/reputation/root/:leaf
 * GET    /v1/reputation/snapshot/:verifierId
 * GET    /v1/reputation/quarantine    - requires Bearer token in PUBLISHER_OPERATOR_TOKENS
 * GET    /metrics                     - requires Bearer token in PUBLISHER_OPERATOR_TOKENS
 * GET    /health
 *
 * `POST /v1/reputation/leaves` only queues the commitment into the durable inbox and
 * acknowledges immediately (202). Publication — the on-chain Soroban round trip — runs on
 * a background tick loop at PUBLISHER_INTERVAL_MS, independent of any single request, with
 * retry on the next interval if a tick fails. Submitters confirm inclusion once the
 * background loop publishes via GET /v1/reputation/root/:leaf or /snapshot/:verifierId.
 * See src/auth.ts for the token issuance flow and src/trusted-proxy.ts for
 * PUBLISHER_TRUSTED_PROXIES, which gates how X-Forwarded-For is honored.
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
import { loadAuthConfigFromEnv, isAuthorizedSubmitter, isAuthorizedOperator } from "../src/auth.ts";
import { loadTrustedProxiesFromEnv, resolveClientSource } from "../src/trusted-proxy.ts";

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
    corsOrigin: process.env.PUBLISHER_CORS_ORIGIN ?? "",
  };
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (Buffer.concat(chunks).length > 32 * 1024) throw new Error("request body too large");
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function send(res, status, body, corsOrigin, contentType = "application/json") {
  res.writeHead(status, {
    "access-control-allow-origin": corsOrigin,
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type",
    "content-type": contentType,
  });
  if (contentType === "application/json") {
    res.end(JSON.stringify(body));
  } else {
    res.end(body);
  }
}

async function rootResponse(store, verifierId, leaf) {
  const normalizedLeaf = normalizeHex32(leaf, "leaf");
  const state = store.load(verifierId);
  const leaves = state?.leaves ?? [];
  const leafValues = leaves.map((x) => x.leaf);
  const proof = await buildProof(leafValues, normalizedLeaf);
  const datasetHash = computeDatasetHash(proof.root, leafValues);
  return {
    verifierId,
    leaf: normalizedLeaf,
    leafIndex: proof.leafIndex,
    leafCount: leafValues.length,
    root: proof.root,
    datasetHash,
    pathElements: proof.pathElements,
    pathIndices: proof.pathIndices,
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
  const authCfg = loadAuthConfigFromEnv();
  const trustedProxies = loadTrustedProxiesFromEnv();

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
  function extractSource(req): string {
    return resolveClientSource(req, trustedProxies);
  }

  const server = createServer(async (req, res) => {
    try {
      if (req.method === "OPTIONS") {
        send(res, 204, {}, cfg.corsOrigin);
        return;
      }

      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

      if (req.method === "POST" && url.pathname === "/v1/reputation/leaves") {
        if (!isAuthorizedSubmitter(req, authCfg)) {
          send(res, 401, { ok: false, error: "unauthorized" }, cfg.corsOrigin);
          return;
        }
        const source = extractSource(req);
        const rl = rateLimiter.consume(source);
        if (!rl.allowed) {
          const retryAfter = Math.ceil((rl.resetMs - Date.now()) / 1000);
          res.setHeader("X-RateLimit-Limit", String(rl.limit));
          res.setHeader("X-RateLimit-Remaining", String(rl.remaining));
          res.setHeader("X-RateLimit-Reset", String(Math.ceil(rl.resetMs / 1000)));
          res.setHeader("Retry-After", String(retryAfter));
          send(res, 429, {
            ok: false,
            error: "rate limit exceeded",
            retryAfterSeconds: retryAfter,
            limit: rl.limit,
            remaining: rl.remaining,
          }, cfg.corsOrigin);
          return;
        }

        const commitment = normalizeCommitment(await readBody(req), () => new Date().toISOString());
        metrics.totalSubmitted += 1;
        const accepted = store.writeInbox(commitment);
        if (!accepted) {
          metrics.totalRejected += 1;
          send(res, 429, {
            ok: false,
            error: "inbox full",
            retryAfterSeconds: 30,
            inboxDepth: store.inboxSize(),
          }, cfg.corsOrigin);
          return;
        }
        metrics.totalAccepted += 1;
        metrics.currentInboxDepth = store.inboxSize();
        const tick = await runPublisherTick({
          verifierId: cfg.verifierId,
          adapter,
          store,
          dataDir: cfg.dataDir,
        }, metrics);
        let inclusion = null;
        if (tick.localRoot) inclusion = await rootResponse(store, cfg.verifierId, commitment.leaf);
        send(res, 202, { ok: true, accepted: commitment, tick, inclusion }, cfg.corsOrigin);
        return;
      }

      const rootMatch = /^\/v1\/reputation\/root\/([^/]+)$/.exec(url.pathname);
      if (req.method === "GET" && rootMatch) {
        try {
          send(res, 200, await rootResponse(store, cfg.verifierId, decodeURIComponent(rootMatch[1])), cfg.corsOrigin);
        } catch {
          send(res, 404, { ok: false, error: "leaf not included in the current reputation root" }, cfg.corsOrigin);
        }
        return;
      }

      const snapshotMatch = /^\/v1\/reputation\/snapshot\/([^/]+)$/.exec(url.pathname);
      if (req.method === "GET" && snapshotMatch) {
        const snapshotVerifierId = decodeURIComponent(snapshotMatch[1]);
        const state = store.load(snapshotVerifierId);
        if (!state || state.leaves.length === 0) {
          send(res, 404, { ok: false, error: "no leaves found for this verifier" }, cfg.corsOrigin);
          return;
        }
        const leafValues = state.leaves.map((x) => x.leaf);
        const snapshot = await buildTreeSnapshot(snapshotVerifierId, leafValues);
        const snapshotHash = computeSnapshotHash(snapshot);
        send(res, 200, { ok: true, snapshot, snapshotHash }, cfg.corsOrigin);
        return;
      }

      if (req.method === "GET" && url.pathname === "/v1/reputation/quarantine") {
        if (!isAuthorizedOperator(req, authCfg)) {
          send(res, 401, { ok: false, error: "unauthorized" }, cfg.corsOrigin);
          return;
        }
        const quarantine = store.listQuarantine();
        send(res, 200, {
          ok: true,
          count: quarantine.length,
          files: quarantine,
        }, cfg.corsOrigin);
        return;
      }

      if (req.method === "GET" && url.pathname === "/metrics") {
        if (!isAuthorizedOperator(req, authCfg)) {
          send(res, 401, { ok: false, error: "unauthorized" }, cfg.corsOrigin);
          return;
        }
        const body = formatPrometheusMetrics(metrics);
        send(res, 200, body, cfg.corsOrigin, "text/plain; version=0.0.4; charset=utf-8");
        return;
      }

      if (req.method === "GET" && url.pathname === "/health") {
        send(res, 200, {
          ok: true,
          verifierId: cfg.verifierId,
          inboxDepth: store.inboxSize(),
          maxInboxSize: MAX_INBOX_SIZE,
          quarantineSize: store.quarantineSize(),
        }, cfg.corsOrigin);
        return;
      }

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

