import { describe, expect, it } from "vitest";
import {
  createAspMetrics,
  formatPrometheusMetrics,
  recordTickFailure,
  recordTickSuccess,
  rootAgeMs,
} from "../src/metrics.ts";

describe("asp metrics", () => {
  it("records a successful publishing tick and computes publication lag", () => {
    const metrics = createAspMetrics();
    let now = 1_000;
    recordTickSuccess(metrics, { published: true, localRoot: "0xabc" }, 42, () => new Date(now).toISOString());

    expect(metrics.totalTicks).toBe(1);
    expect(metrics.totalPublished).toBe(1);
    expect(metrics.lastTickError).toBeNull();
    expect(metrics.lastPublishedRoot).toBe("0xabc");

    now = 6_000;
    expect(rootAgeMs(metrics, now)).toBe(5_000);
  });

  it("records failures without touching publication fields", () => {
    const metrics = createAspMetrics();
    recordTickFailure(metrics, new Error("rpc timeout"), 10, () => "2026-01-01T00:00:00.000Z");

    expect(metrics.totalTicks).toBe(1);
    expect(metrics.totalFailures).toBe(1);
    expect(metrics.lastTickError).toBe("rpc timeout");
    expect(metrics.lastPublishAt).toBeNull();
  });

  it("counts reorg halts and stale alerts separately from publications", () => {
    const metrics = createAspMetrics();
    recordTickSuccess(metrics, { haltedForReorg: true }, 5);
    recordTickSuccess(metrics, { staleAlert: { root: "0x1", ageMs: 999, thresholdMs: 500 } }, 5);

    expect(metrics.totalHaltedForReorg).toBe(1);
    expect(metrics.totalStaleAlerts).toBe(1);
    expect(metrics.totalPublished).toBe(0);
  });

  it("returns null root age until something has published", () => {
    const metrics = createAspMetrics();
    expect(rootAgeMs(metrics)).toBeNull();
  });

  it("formats prometheus exposition output with the documented metric names", () => {
    const metrics = createAspMetrics();
    recordTickSuccess(metrics, { published: true, localRoot: "0xabc" }, 12);
    const output = formatPrometheusMetrics(metrics);

    expect(output).toContain("asp_total_ticks 1");
    expect(output).toContain("asp_total_published 1");
    expect(output).toContain("asp_last_tick_duration_ms 12");
    expect(output).toContain("asp_publication_lag_ms");
    expect(output).toContain("asp_uptime_seconds");
  });
});
