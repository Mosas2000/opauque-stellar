// @ts-nocheck
/**
 * ASP HTTP server: runs the reconcile loop in the background and exposes health, metrics,
 * and the current association-set manifest so an orchestrator can probe it and Prometheus
 * can scrape it — mirroring the publisher's `/health` + `/metrics` API.
 *
 *   GET /health   — tick success + root freshness (503 when stale/failing)
 *   GET /metrics  — Prometheus exposition format (tick duration, publication lag, failures)
 *   GET /manifest — current association-set manifest (data/sets/<poolId>/latest.json)
 *
 * Config: same env vars as `indexer.ts` (see its header comment), plus:
 *   ASP_HTTP_HOST (default 127.0.0.1), ASP_HTTP_PORT (default 8791), ASP_CORS_ORIGIN (default *).
 */
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { StellarChainAdapter } from "../src/chains/stellar.ts";
import { FileStore } from "../src/store.ts";
import { createAspMetrics, formatPrometheusMetrics, rootAgeMs } from "../src/metrics.ts";
import { createPublicationMonitor, createReorgGuard, loadConfig, tick } from "./indexer.ts";

const NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";

function send(res, status, body, corsOrigin, contentType = "application/json") {
  res.writeHead(status, {
    "access-control-allow-origin": corsOrigin,
    "access-control-allow-methods": "GET,OPTIONS",
    "access-control-allow-headers": "content-type",
    "content-type": contentType,
  });
  res.end(contentType === "application/json" ? JSON.stringify(body) : body);
}

async function main() {
  const cfg = loadConfig();
  const host = process.env.ASP_HTTP_HOST ?? "127.0.0.1";
  const port = Number(process.env.ASP_HTTP_PORT ?? 8791);
  const corsOrigin = process.env.ASP_CORS_ORIGIN ?? "*";

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
  const metrics = createAspMetrics();

  async function loop() {
    // eslint-disable-next-line no-constant-condition
    for (;;) {
      try {
        await tick(cfg, adapter, store, monitor, guard, metrics);
      } catch (e) {
        console.error(`tick error: ${e?.message ?? e}`);
      }
      await new Promise((r) => setTimeout(r, cfg.intervalMs));
    }
  }
  loop();

  const server = createServer((req, res) => {
    try {
      if (req.method === "OPTIONS") {
        send(res, 204, {}, corsOrigin);
        return;
      }
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

      if (req.method === "GET" && url.pathname === "/health") {
        const age = rootAgeMs(metrics);
        // Fresh until a root has ever published and its age exceeds the monitor threshold.
        const rootFresh = age === null || age <= cfg.maxRootAgeMs;
        const ok = metrics.lastTickError === null && rootFresh;
        send(
          res,
          ok ? 200 : 503,
          {
            ok,
            poolId: cfg.poolId,
            totalTicks: metrics.totalTicks,
            totalFailures: metrics.totalFailures,
            lastTickAt: metrics.lastTickAt,
            lastTickError: metrics.lastTickError,
            lastPublishAt: metrics.lastPublishAt,
            rootAgeMs: age,
            maxRootAgeMs: cfg.maxRootAgeMs,
            rootFresh,
          },
          corsOrigin,
        );
        return;
      }

      if (req.method === "GET" && url.pathname === "/metrics") {
        send(res, 200, formatPrometheusMetrics(metrics), corsOrigin, "text/plain; version=0.0.4; charset=utf-8");
        return;
      }

      if (req.method === "GET" && url.pathname === "/manifest") {
        const manifestPath = join(cfg.dataDir, "sets", cfg.poolId, "latest.json");
        if (!existsSync(manifestPath)) {
          send(res, 404, { ok: false, error: "no manifest published yet" }, corsOrigin);
          return;
        }
        send(res, 200, JSON.parse(readFileSync(manifestPath, "utf8")), corsOrigin);
        return;
      }

      send(res, 404, { ok: false, error: "not found" }, corsOrigin);
    } catch (err) {
      send(res, 500, { ok: false, error: err?.message ?? String(err) }, corsOrigin);
    }
  });

  server.listen(port, host, () => {
    console.log(`ASP HTTP server listening on http://${host}:${port} (pool=${cfg.poolId})`);
  });
}

main().catch((err) => {
  console.error(err?.message ?? err);
  process.exit(1);
});
