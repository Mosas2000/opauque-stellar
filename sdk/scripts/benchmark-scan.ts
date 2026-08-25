#!/usr/bin/env node
/**
 * Pure-TS reference scanner benchmark (#604, updated by #772).
 *
 * Generates a deterministic synthetic fixture of announcements (default
 * 120,000 — comfortably above the 100k floor in the issue) and benchmarks
 * `scanAnnouncementsViewOnly` (the pure-TS *reference* scanner) against it,
 * reporting throughput and peak/final heap usage.
 *
 * This is one half of the picture: `scanner/README.md` documents the
 * production scanner as the compiled Rust/WASM implementation in `scanner/`,
 * not this reference implementation — see `benchmark-scan-wasm.ts` for that
 * benchmark, and `benchmark-scan-report.ts` for the script that runs both
 * and writes the combined side-by-side numbers to the README.
 *
 * Usage:
 *   npx tsx scripts/benchmark-scan.ts [fixtureSize] [chunkSize]
 *
 * For an accurate peak-heap reading, run with `node --expose-gc` so the
 * script can force a clean baseline before scanning:
 *   node --expose-gc -r tsx/cjs scripts/benchmark-scan.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { scanAnnouncementsViewOnly } from "../src/crypto/scan";
import { buildFixture, formatMs, heapMb } from "./lib/benchmark-fixture.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const fixtureSize = Number(process.argv[2] ?? 120_000);
  const chunkSize = Number(process.argv[3] ?? 10_000);

  console.log(`[benchmark-scan] Building deterministic fixture of ${fixtureSize.toLocaleString()} announcements…`);
  const buildStart = process.hrtime.bigint();
  const fixture = buildFixture(fixtureSize);
  const buildMs = Number(process.hrtime.bigint() - buildStart) / 1e6;
  console.log(`[benchmark-scan] Fixture built in ${formatMs(buildMs)} (${fixture.plantedCount} planted matches).`);

  if (typeof global.gc === "function") {
    global.gc();
  }
  const baselineHeap = heapMb();
  let peakHeap = baselineHeap;

  const allMatches: ReturnType<typeof scanAnnouncementsViewOnly> = [];
  const scanStart = process.hrtime.bigint();

  for (let offset = 0; offset < fixture.announcements.length; offset += chunkSize) {
    const chunk = fixture.announcements.slice(offset, offset + chunkSize);
    const matches = scanAnnouncementsViewOnly({
      announcements: chunk,
      viewingKey: fixture.viewingKey,
      spendingPubKey: fixture.spendingPubKey,
    });
    allMatches.push(...matches);
    peakHeap = Math.max(peakHeap, heapMb());
    // Yield to the event loop between chunks so this behaves like a
    // long-running scan rather than one giant synchronous block, and so
    // memory sampling reflects genuinely separate points in time.
    await new Promise((resolve) => setImmediate(resolve));
  }

  const scanMs = Number(process.hrtime.bigint() - scanStart) / 1e6;
  const finalHeap = heapMb();
  const throughput = fixture.announcements.length / (scanMs / 1000);

  if (allMatches.length !== fixture.plantedCount) {
    console.error(
      `[benchmark-scan] CORRECTNESS FAILURE: expected ${fixture.plantedCount} matches, found ${allMatches.length}.`,
    );
    process.exitCode = 1;
    return;
  }

  const results = {
    timestamp: new Date().toISOString(),
    fixtureSize: fixture.announcements.length,
    chunkSize,
    plantedMatches: fixture.plantedCount,
    matchesFound: allMatches.length,
    scanMs: Math.round(scanMs),
    throughputPerSec: Math.round(throughput),
    baselineHeapMb: Math.round(baselineHeap * 10) / 10,
    peakHeapMb: Math.round(peakHeap * 10) / 10,
    finalHeapMb: Math.round(finalHeap * 10) / 10,
  };

  console.log("[benchmark-scan] Results:", results);

  const outPath = path.resolve(__dirname, "..", "ts-benchmark-result.json");
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2) + "\n", "utf-8");
  console.log(`[benchmark-scan] Results written to ${outPath} (combined into scanner/README.md by benchmark-scan-report.ts).`);
}

main().catch((err) => {
  console.error("[benchmark-scan] Fatal:", err);
  process.exitCode = 1;
});
