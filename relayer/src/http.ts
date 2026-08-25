import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { GOSSIP_TOPIC } from "./gossip.ts";
import {
  validateAdvert,
  validatePayload,
  validateRelayerMessage,
  type EncryptedPayload,
  type JobAdvert,
  type RelayerBid,
  type RelayerMessage,
} from "./messages.ts";

import {
  createGlobalRateLimiterFromEnv,
  createRateLimiterFromEnv,
  type RateLimiter,
  type RateLimitResult,
} from "./rate-limit.ts";

import type { PayoutReconciler } from "./reconciler.ts";
import { loadTrustedProxiesFromEnv, resolveClientSource } from "./trusted-proxy.ts";


export type RelayerHttpBackend = {
  readonly stats: unknown;
  bidsFor(jobId: string): RelayerBid[];
  handleAdvert(advert: JobAdvert): Promise<RelayerBid | null> | Promise<null>;
  handlePayload(payload: EncryptedPayload): Promise<{ acceptedTx: string; submittedTx: string } | null> | Promise<null>;
  publishGossipMessage?(message: RelayerMessage): Promise<void>;
  subscribeGossip?(handler: (message: RelayerMessage) => Promise<void> | void): () => void;
  healthCheck?(): Promise<unknown>;
  /** Optional reconciler — enables GET /v1/reconcile and POST /v1/reconcile endpoints. */
  reconciler?: PayoutReconciler;
  /** Optional completion-rate scoring — enables GET /v1/relayers/scores(/:operator). */
  scoreFor?(operator: string): unknown;
  allScores?(): unknown[];
};

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-origin": "*",
    "content-type": "application/json",
  });
  res.end(JSON.stringify(body));
}

function readGossipEnvelope(value: unknown): RelayerMessage {
  const env = value as { topic?: unknown; message?: unknown };
  if (env?.topic !== GOSSIP_TOPIC) throw new Error("Invalid gossip topic.");
  return validateRelayerMessage(env.message);
}

export function createRelayerHttpServer(
  backend: RelayerHttpBackend,
  rateLimiter?: RateLimiter,
  globalRateLimiter?: RateLimiter,
) {
  // Layered: `global` is a loose per-source cap applied to every request (catches a
  // flood spread across endpoints); `limiter` is a tight cap on state-mutating routes.
  const limiter = rateLimiter ?? createRateLimiterFromEnv();
  const globalLimiter = globalRateLimiter ?? createGlobalRateLimiterFromEnv();
  const trustedProxies = loadTrustedProxiesFromEnv();

  function extractSource(req: IncomingMessage): string {
    return resolveClientSource(req, trustedProxies);
  }

  function applyRateLimitHeaders(res: ServerResponse, rl: RateLimitResult): void {
    res.setHeader("X-RateLimit-Limit", String(rl.limit));
    res.setHeader("X-RateLimit-Remaining", String(rl.remaining));
    res.setHeader("X-RateLimit-Reset", String(Math.ceil(rl.resetMs / 1000)));
  }

  function rejectRateLimited(res: ServerResponse, rl: RateLimitResult): void {
    const retryAfter = Math.max(0, Math.ceil((rl.resetMs - Date.now()) / 1000));
    res.writeHead(429, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "content-type",
      "content-type": "application/json",
      "X-RateLimit-Limit": String(rl.limit),
      "X-RateLimit-Remaining": String(rl.remaining),
      "X-RateLimit-Reset": String(Math.ceil(rl.resetMs / 1000)),
      "Retry-After": String(retryAfter),
    });
    res.end(JSON.stringify({ ok: false, error: "rate limit exceeded", retryAfterSeconds: retryAfter }));
  }

  /**
   * Checks each layer in order for this source, stamping standard rate-limit headers
   * onto `res` regardless of outcome. Stops and sends 429 on the first layer that
   * denies the request. Returns true if the request was rejected (caller must stop).
   */
  function rateLimited(req: IncomingMessage, res: ServerResponse, layers: RateLimiter[] = [globalLimiter, limiter]): boolean {
    const source = extractSource(req);
    for (const layer of layers) {
      const rl = layer.consume(source);
      applyRateLimitHeaders(res, rl);
      if (!rl.allowed) {
        rejectRateLimited(res, rl);
        return true;
      }
    }
    return false;
  }

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method === "OPTIONS") {
        send(res, 204, {});
        return;
      }
      // Loose layer, every request: catches a flood spread across endpoints that a
      // per-route check would never see. Write routes additionally check the tight
      // layer below, so this one is only consumed once per request.
      if (rateLimited(req, res, [globalLimiter])) return;
      if (req.method === "GET" && url.pathname === "/v1/gossip/stream") {
        if (!backend.subscribeGossip) {
          send(res, 404, { error: "gossip unavailable" });
          return;
        }
        res.writeHead(200, {
          "access-control-allow-origin": "*",
          "cache-control": "no-cache, no-transform",
          "connection": "keep-alive",
          "content-type": "text/event-stream",
        });
        res.write(`: ${GOSSIP_TOPIC}\n\n`);
        const unsubscribe = backend.subscribeGossip((message) => {
          res.write(`data: ${JSON.stringify({ topic: GOSSIP_TOPIC, message })}\n\n`);
        });
        req.on("close", unsubscribe);
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/gossip/messages") {
        if (rateLimited(req, res, [limiter])) return;
        if (!backend.publishGossipMessage) {
          send(res, 404, { error: "gossip unavailable" });
          return;
        }
        await backend.publishGossipMessage(readGossipEnvelope(await readJson(req)));
        send(res, 202, { ok: true });
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/jobs") {
        if (rateLimited(req, res, [limiter])) return;
        const advert = validateAdvert(await readJson(req));
        const bid = await backend.handleAdvert(advert);
        send(res, 202, { ok: true, bid });
        return;
      }
      const bidMatch = /^\/v1\/jobs\/([^/]+)\/bids$/.exec(url.pathname);
      if (req.method === "GET" && bidMatch) {
        const bids: RelayerBid[] = backend.bidsFor(decodeURIComponent(bidMatch[1]));
        send(res, 200, { bids });
        return;
      }
      const payloadMatch = /^\/v1\/jobs\/([^/]+)\/payload$/.exec(url.pathname);
      if (req.method === "POST" && payloadMatch) {
        if (rateLimited(req, res, [limiter])) return;
        const payload = validatePayload(await readJson(req));
        const idempotencyKey = req.headers["x-idempotency-key"] as string | undefined;
        if (idempotencyKey) {
          payload.idempotencyKey = idempotencyKey;
        }
        if (payload.jobId.toLowerCase() !== decodeURIComponent(payloadMatch[1]).toLowerCase()) {
          send(res, 400, { error: "jobId mismatch" });
          return;
        }
        const result = await backend.handlePayload(payload);
        send(res, 202, { ok: true, result });
        return;
      }
      // GET /v1/relayers/scores — market-wide completion-rate scores, for the selection UI.
      if (req.method === "GET" && url.pathname === "/v1/relayers/scores") {
        if (!backend.allScores) {
          send(res, 404, { error: "scoring unavailable" });
          return;
        }
        send(res, 200, { scores: backend.allScores() });
        return;
      }
      const scoreMatch = /^\/v1\/relayers\/([^/]+)\/score$/.exec(url.pathname);
      if (req.method === "GET" && scoreMatch) {
        if (!backend.scoreFor) {
          send(res, 404, { error: "scoring unavailable" });
          return;
        }
        send(res, 200, { score: backend.scoreFor(decodeURIComponent(scoreMatch[1])) });
        return;
      }
      if (req.method === "GET" && url.pathname === "/health") {
        if (backend.healthCheck) {
          const health = await backend.healthCheck();
          send(res, 200, health);
        } else {
          send(res, 200, { ok: true, stats: backend.stats });
        }
        return;
      }
      // GET /v1/reconcile — return the most recent reconciliation report without re-running
      if (req.method === "GET" && url.pathname === "/v1/reconcile") {
        if (!backend.reconciler) {
          send(res, 404, { error: "reconciler not configured" });
          return;
        }
        const last = backend.reconciler.getLastReport();
        if (!last) {
          send(res, 204, {});
          return;
        }
        send(res, 200, last);
        return;
      }
      // POST /v1/reconcile — trigger an on-demand reconciliation run and return the report
      if (req.method === "POST" && url.pathname === "/v1/reconcile") {
        if (!backend.reconciler) {
          send(res, 404, { error: "reconciler not configured" });
          return;
        }
        const report = await backend.reconciler.reconcile();
        send(res, 200, report);
        return;
      }
      send(res, 404, { error: "not found" });
    } catch (err) {
      send(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
  });
}
