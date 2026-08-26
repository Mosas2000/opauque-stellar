#!/usr/bin/env node
/**
 * WASM scanner benchmark (#772).
 *
 * `sdk/scripts/benchmark-scan.ts` benchmarks `scanAnnouncementsViewOnly`, the
 * pure-TS *reference* scanner — but `scanner/README.md` documents throughput
 * numbers as if they applied to the compiled Rust/WASM scanner (`scanner/`)
 * that the frontend and production actually run. This script drives the real
 * `scan_announcements_view_only_wasm` WASM export over the identical fixture
 * generator as the TS benchmark, so the two numbers are directly comparable
 * and the README can report both honestly.
 *
 * Usage (from `sdk/`):
 *   npx tsx scripts/benchmark-scan-wasm.ts [fixtureSize] [chunkSize]
 *
 * Requires the scanner WASM to be built for the `nodejs` target first (this
 * is a *different* wasm-pack target than `npm run build:scanner`, which
 * builds for `web`/browser use and cannot be `require()`d directly from
 * plain Node):
 *   cd scanner && wasm-pack build --target nodejs --out-dir ../sdk/wasm-node-pkg --release
 * `npm run benchmark:scan:wasm` runs that build step first automatically.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { buildFixture, formatMs, heapMb } from "./lib/benchmark-fixture.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const WASM_NODE_PKG = path.resolve(__dirname, "..", "wasm-node-pkg");

interface WasmScannerModule {
  scan_announcements_view_only_wasm(
    announcementsJson: string,
    viewPrivkeyBytes: Uint8Array,
    spendPubkeyBytes: Uint8Array,
  ): string;
  get_scanner_metadata(): string;
}

function loadWasmModule(): WasmScannerModule {
  const entry = path.join(WASM_NODE_PKG, "opauque_scanner.js");
  if (!fs.existsSync(entry)) {
    console.error(
      `[benchmark-scan-wasm] WASM module not found at ${entry}.\n` +
        "Build it first: cd scanner && wasm-pack build --target nodejs --out-dir ../sdk/wasm-node-pkg --release\n" +
        "(or run: npm run benchmark:scan:wasm, which does this automatically).",
    );
    process.exit(1);
  }
  return require(entry) as WasmScannerModule;
}

/** Serializes a StealthAnnouncement for the WASM function's expected JSON
 * shape: `ephemeralPubKey` as a hex string (no `0x` prefix required — the
 * Rust side strips one if present), matching the convention already used by
 * `frontend/src/hooks/useViewOnlyScan.ts` for the per-item WASM check. */
function toWasmJson(announcements: { stealthAddress: string; ephemeralPubKey: Uint8Array; viewTag: number }[]): string {
  return JSON.stringify(
    announcements.map((a) => ({
      eventVersion: 1,
      stealthAddress: a.stealthAddress,
      ephemeralPubKey: Buffer.from(a.ephemeralPubKey).toString("hex"),
      viewTag: a.viewTag,
    })),
  );
}

async function main(): Promise<void> {
  const fixtureSize = Number(process.argv[2] ?? 120_000);
  const chunkSize = Number(process.argv[3] ?? 10_000);

  const wasm = loadWasmModule();
  const metadata = JSON.parse(wasm.get_scanner_metadata()) as { version: string; buildHash: string };
  console.log(`[benchmark-scan-wasm] Scanner WASM v${metadata.version} (build ${metadata.buildHash})`);

  console.log(`[benchmark-scan-wasm] Building deterministic fixture of ${fixtureSize.toLocaleString()} announcements…`);
  const buildStart = process.hrtime.bigint();
  const fixture = buildFixture(fixtureSize);
  const buildMs = Number(process.hrtime.bigint() - buildStart) / 1e6;
  console.log(`[benchmark-scan-wasm] Fixture built in ${formatMs(buildMs)} (${fixture.plantedCount} planted matches).`);

  if (typeof global.gc === "function") {
    global.gc();
  }
  const baselineHeap = heapMb();
  let peakHeap = baselineHeap;

  let totalMatches = 0;
  const scanStart = process.hrtime.bigint();

  for (let offset = 0; offset < fixture.announcements.length; offset += chunkSize) {
    const chunk = fixture.announcements.slice(offset, offset + chunkSize);
    const matchesJson = wasm.scan_announcements_view_only_wasm(
      toWasmJson(chunk),
      fixture.viewingKey,
      fixture.spendingPubKey,
    );
    const matches = JSON.parse(matchesJson) as unknown[];
    totalMatches += matches.length;
    peakHeap = Math.max(peakHeap, heapMb());
    // Yield to the event loop between chunks — same rationale as the TS
    // benchmark: behaves like a long-running scan, and gives a genuinely
    // separate sampling point for heap usage rather than one giant block.
    await new Promise((resolve) => setImmediate(resolve));
  }

  const scanMs = Number(process.hrtime.bigint() - scanStart) / 1e6;
  const finalHeap = heapMb();
  const throughput = fixture.announcements.length / (scanMs / 1000);

  if (totalMatches !== fixture.plantedCount) {
    console.error(
      `[benchmark-scan-wasm] CORRECTNESS FAILURE: expected ${fixture.plantedCount} matches, found ${totalMatches}.`,
    );
    process.exitCode = 1;
    return;
  }

  const results = {
    timestamp: new Date().toISOString(),
    scannerVersion: metadata.version,
    scannerBuildHash: metadata.buildHash,
    fixtureSize: fixture.announcements.length,
    chunkSize,
    plantedMatches: fixture.plantedCount,
    matchesFound: totalMatches,
    scanMs: Math.round(scanMs),
    throughputPerSec: Math.round(throughput),
    baselineHeapMb: Math.round(baselineHeap * 10) / 10,
    peakHeapMb: Math.round(peakHeap * 10) / 10,
    finalHeapMb: Math.round(finalHeap * 10) / 10,
  };

  console.log("[benchmark-scan-wasm] Results:", results);

  const outPath = path.resolve(__dirname, "..", "wasm-benchmark-result.json");
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2) + "\n", "utf-8");
  console.log(`[benchmark-scan-wasm] Results written to ${outPath} (combined into scanner/README.md by benchmark-scan-report.ts).`);
}

main().catch((err) => {
  console.error("[benchmark-scan-wasm] Fatal:", err);
  process.exitCode = 1;
});
