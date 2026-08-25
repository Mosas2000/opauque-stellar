import { describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { createRelayerHttpServer, type RelayerHttpBackend } from "../src/http.ts";
import { RateLimiter } from "../src/rate-limit.ts";

function fakeBackend(): RelayerHttpBackend {
  return {
    stats: {},
    bidsFor: () => [],
    handleAdvert: async () => null,
    handlePayload: async () => null,
  };
}

async function listen(server: ReturnType<typeof createRelayerHttpServer>): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

describe("relayer HTTP API — request body limits (413)", () => {
  it("rejects an oversized body with 413 and a stable error code without buffering it fully", async () => {
    const loose = new RateLimiter(60_000, 10_000, 10_000);
    const tight = new RateLimiter(60_000, 10_000, 10_000);
    const server = createRelayerHttpServer(fakeBackend(), tight, loose);
    const base = await listen(server);
    try {
      const before = process.memoryUsage().heapUsed;
      const oversized = "a".repeat(5 * 1024 * 1024); // 5 MiB
      const res = await fetch(`${base}/v1/jobs`, {
        method: "POST",
        body: JSON.stringify({ blob: oversized }),
      });
      const after = process.memoryUsage().heapUsed;

      expect(res.status).toBe(413);
      const body = await res.json();
      expect(body.code).toBe("PAYLOAD_TOO_LARGE");
      expect(after - before).toBeLessThan(2 * 1024 * 1024);
    } finally {
      server.close();
    }
  });
});
