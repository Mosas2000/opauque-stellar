import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createPublisherHttpServer, runPublisherLoop } from "../src/http.ts";
import { createMetrics } from "../src/engine.ts";
import { MemoryStore } from "../src/store.ts";
import { RateLimiter } from "../src/rate-limit.ts";
import { bigintToHex32 } from "../src/bytes.ts";
import type { ChainAdapter } from "../src/types.ts";

class FakeAdapter implements ChainAdapter {
  root: string | null = null;
  posts: Array<{ root: string; datasetHash: string }> = [];
  async currentRoot(): Promise<string | null> {
    return this.root;
  }
  async postRoot(root: string, datasetHash: string) {
    this.root = root;
    this.posts.push({ root, datasetHash });
    return { hash: `tx-${this.posts.length}`, ledger: 100 + this.posts.length };
  }
}

async function listen(server: ReturnType<typeof createServer>): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

describe("publisher HTTP API — async publication (queue, don't publish inline)", () => {
  it("acknowledges a leaf submission immediately without running the on-chain tick", async () => {
    const store = new MemoryStore();
    const metrics = createMetrics();
    const adapter = new FakeAdapter();
    const server = createPublisherHttpServer({
      verifierId: "CVERIFIER",
      store,
      metrics,
      rateLimiter: new RateLimiter(60_000, 1000, 1000),
    });
    const base = await listen(server);
    try {
      const res = await fetch(`${base}/v1/reputation/leaves`, {
        method: "POST",
        body: JSON.stringify({ id: "a", leaf: bigintToHex32(1n) }),
      });
      expect(res.status).toBe(202);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.queued).toBe(true);
      expect(body.tick).toBeUndefined(); // no synchronous tick result
      expect(adapter.posts.length).toBe(0); // publication has not happened yet
      expect(store.inboxSize()).toBe(1);
    } finally {
      server.close();
    }
  });

  it("publishes on the background loop, independent of the request, and is visible via the root endpoint", async () => {
    const store = new MemoryStore();
    const metrics = createMetrics();
    const adapter = new FakeAdapter();
    const server = createPublisherHttpServer({
      verifierId: "CVERIFIER",
      store,
      metrics,
      rateLimiter: new RateLimiter(60_000, 1000, 1000),
    });
    const base = await listen(server);
    try {
      const leaf = bigintToHex32(1n);
      await fetch(`${base}/v1/reputation/leaves`, {
        method: "POST",
        body: JSON.stringify({ id: "a", leaf }),
      });
      expect(adapter.posts.length).toBe(0);

      const controller = new AbortController();
      await runPublisherLoop({
        verifierId: "CVERIFIER",
        adapter,
        store,
        metrics,
        intervalMs: 1,
        signal: controller.signal,
        onTick: () => controller.abort(), // stop after the first tick
      });

      expect(adapter.posts.length).toBe(1);
      const rootRes = await fetch(`${base}/v1/reputation/root/${encodeURIComponent(leaf)}`);
      expect(rootRes.status).toBe(200);
      const rootBody = await rootRes.json();
      expect(rootBody.root).toBe(adapter.root);
    } finally {
      server.close();
    }
  });

  it("retries a failed background tick on the next interval instead of throwing", async () => {
    const store = new MemoryStore();
    const metrics = createMetrics();
    let attempts = 0;
    const adapter: ChainAdapter = {
      async currentRoot() {
        attempts += 1;
        if (attempts === 1) throw new Error("simulated rpc failure");
        return null;
      },
      async postRoot(root: string, datasetHash: string) {
        return { hash: "tx-1", ledger: 1 };
      },
    };
    store.inbox = [{ id: "a", leaf: bigintToHex32(1n), submittedAt: "2026-01-01T00:00:00Z" }];

    const controller = new AbortController();
    let tickCount = 0;
    await runPublisherLoop({
      verifierId: "CVERIFIER",
      adapter,
      store,
      metrics,
      intervalMs: 1,
      signal: controller.signal,
      onTick: () => {
        tickCount += 1;
        if (tickCount >= 1) controller.abort();
      },
      onError: () => {
        // First attempt fails; loop must retry rather than crash.
      },
    });

    expect(metrics.totalTickFailures).toBe(1);
    expect(tickCount).toBe(1);
  });
});

describe("publisher HTTP API — request body limits (413)", () => {
  it("rejects an oversized body with 413 and a stable error code without buffering it fully", async () => {
    const store = new MemoryStore();
    const metrics = createMetrics();
    const server = createPublisherHttpServer({
      verifierId: "CVERIFIER",
      store,
      metrics,
      rateLimiter: new RateLimiter(60_000, 1000, 1000),
      maxBodyBytes: 1024,
    });
    const base = await listen(server);
    try {
      const before = process.memoryUsage().heapUsed;
      const oversized = "a".repeat(5 * 1024 * 1024); // 5 MiB, far past the 1 KiB limit
      const res = await fetch(`${base}/v1/reputation/leaves`, {
        method: "POST",
        body: JSON.stringify({ id: "a", leaf: oversized }),
      });
      const after = process.memoryUsage().heapUsed;

      expect(res.status).toBe(413);
      const body = await res.json();
      expect(body.code).toBe("PAYLOAD_TOO_LARGE");
      // Bounded behavior: heap growth stays well below the oversized payload size (~5 MiB),
      // i.e. the server aborted the read instead of buffering the whole body.
      expect(after - before).toBeLessThan(2 * 1024 * 1024);
      expect(store.inboxSize()).toBe(0);
    } finally {
      server.close();
    }
  });

  it("accepts a body within the limit", async () => {
    const store = new MemoryStore();
    const metrics = createMetrics();
    const server = createPublisherHttpServer({
      verifierId: "CVERIFIER",
      store,
      metrics,
      rateLimiter: new RateLimiter(60_000, 1000, 1000),
      maxBodyBytes: 32 * 1024,
    });
    const base = await listen(server);
    try {
      const res = await fetch(`${base}/v1/reputation/leaves`, {
        method: "POST",
        body: JSON.stringify({ id: "a", leaf: bigintToHex32(1n) }),
      });
      expect(res.status).toBe(202);
    } finally {
      server.close();
    }
  });
});
