/**
 * Tests for the shared benchmark fixture generator (#772).
 *
 * This fixture underpins both scan benchmarks (`benchmark-scan.ts` for the
 * pure-TS scanner, `benchmark-scan-wasm.ts` for the WASM scanner) — a bug
 * here would silently corrupt the throughput numbers reported for BOTH
 * implementations without either benchmark script noticing (each already
 * self-checks planted-match count against what it finds, but that only
 * catches a scanner regression, not a fixture-generation regression that
 * affects both scanners identically).
 */
import { describe, it, expect } from "vitest";
import { buildFixture } from "../../scripts/lib/benchmark-fixture";
import { scanAnnouncementsViewOnly } from "../../src/crypto/scan";

describe("buildFixture", () => {
  it("is deterministic: identical size produces byte-identical fixtures", () => {
    const a = buildFixture(500);
    const b = buildFixture(500);

    expect(a.plantedCount).toBe(b.plantedCount);
    expect(a.viewingKey).toEqual(b.viewingKey);
    expect(a.spendingPubKey).toEqual(b.spendingPubKey);
    expect(a.announcements).toEqual(b.announcements);
  });

  it("produces exactly `size` announcements", () => {
    const fixture = buildFixture(1234);
    expect(fixture.announcements).toHaveLength(1234);
  });

  it("plants at least one true match for any fixture large enough to contain one", () => {
    const fixture = buildFixture(5000);
    expect(fixture.plantedCount).toBeGreaterThan(0);
  });

  it("plants matches at the expected density (size / plantEvery, rounded up)", () => {
    const fixture = buildFixture(10_000, 1000);
    // Indices 0, 1000, 2000, ..., 9000 -> 10 planted matches.
    expect(fixture.plantedCount).toBe(10);
  });

  it("every planted match is independently verifiable by the pure-TS scanner", () => {
    // This is the real correctness guarantee both benchmark scripts rely on:
    // the fixture's plantedCount must equal what an independent, trusted
    // scan implementation actually finds — not just an internal counter.
    const fixture = buildFixture(3000, 500);

    const matches = scanAnnouncementsViewOnly({
      announcements: fixture.announcements,
      viewingKey: fixture.viewingKey,
      spendingPubKey: fixture.spendingPubKey,
    });

    expect(matches).toHaveLength(fixture.plantedCount);
  });

  it("noise announcements have valid curve points but do not match the recipient", () => {
    const fixture = buildFixture(2000, 10_000); // plantEvery > size -> only index 0 planted
    expect(fixture.plantedCount).toBe(1);

    const matches = scanAnnouncementsViewOnly({
      announcements: fixture.announcements,
      viewingKey: fixture.viewingKey,
      spendingPubKey: fixture.spendingPubKey,
    });

    expect(matches).toHaveLength(1);
    expect(matches[0]!.announcement).toBe(fixture.announcements[0]);
  });

  it("every ephemeralPubKey is a valid compressed secp256k1 point (33 bytes, correct prefix)", () => {
    const fixture = buildFixture(200);
    for (const ann of fixture.announcements) {
      expect(ann.ephemeralPubKey).toHaveLength(33);
      expect([0x02, 0x03]).toContain(ann.ephemeralPubKey[0]);
    }
  });

  it("every stealthAddress is a well-formed 20-byte hex string", () => {
    const fixture = buildFixture(200);
    for (const ann of fixture.announcements) {
      expect(ann.stealthAddress).toMatch(/^0x[0-9a-f]{40}$/);
    }
  });
});
