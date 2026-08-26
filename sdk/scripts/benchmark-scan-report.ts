#!/usr/bin/env node
/**
 * Combined TS + WASM scan benchmark report (#772).
 *
 * Runs the pure-TS reference benchmark and the WASM benchmark against the
 * identical fixture, then writes both results side by side into
 * `scanner/README.md`. This is the standard entrypoint
 * (`npm run benchmark:scan` from `sdk/`) — it builds the scanner WASM for
 * the `nodejs` target first if the package isn't already present, so a
 * fresh checkout works without a manual build step.
 *
 * Usage (from `sdk/`):
 *   npx tsx scripts/benchmark-scan-report.ts [fixtureSize] [chunkSize]
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SDK_ROOT = path.resolve(__dirname, "..");
const SCANNER_ROOT = path.resolve(SDK_ROOT, "..", "scanner");
const WASM_NODE_PKG = path.join(SDK_ROOT, "wasm-node-pkg");

interface BenchmarkResult {
  timestamp: string;
  fixtureSize: number;
  chunkSize: number;
  plantedMatches: number;
  matchesFound: number;
  scanMs: number;
  throughputPerSec: number;
  baselineHeapMb: number;
  peakHeapMb: number;
  finalHeapMb: number;
  scannerVersion?: string;
  scannerBuildHash?: string;
}

function run(label: string, cmd: string, args: string[], opts: { cwd?: string } = {}): void {
  console.log(`\n> ${label}`);
  const result = spawnSync(cmd, args, {
    cwd: opts.cwd ?? SDK_ROOT,
    stdio: "inherit",
    env: process.env,
  });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function ensureWasmNodeBuild(): void {
  const entry = path.join(WASM_NODE_PKG, "opauque_scanner.js");
  if (fs.existsSync(entry)) return;

  const wasmPack = process.env.WASM_PACK ?? "wasm-pack";
  console.log(`[benchmark-scan-report] Building scanner WASM for the nodejs target (one-time)…`);
  run(
    "cd scanner && wasm-pack build --target nodejs --out-dir ../sdk/wasm-node-pkg --release",
    wasmPack,
    ["build", "--target", "nodejs", "--out-dir", path.relative(SCANNER_ROOT, WASM_NODE_PKG), "--release"],
    { cwd: SCANNER_ROOT },
  );
}

function writeResultsToReadme(ts: BenchmarkResult, wasm: BenchmarkResult): void {
  const readmePath = path.resolve(SDK_ROOT, "..", "scanner", "README.md");
  const marker = "<!-- benchmark-scan:latest -->";
  const speedup = (wasm.throughputPerSec / ts.throughputPerSec).toFixed(2);

  const block = [
    marker,
    "### Latest benchmark run",
    "",
    `- **Run at**: ${wasm.timestamp}`,
    `- **Fixture size**: ${wasm.fixtureSize.toLocaleString()} announcements (${wasm.plantedMatches} planted true positives; both implementations verified ${wasm.matchesFound}/${ts.matchesFound} matches found)`,
    `- **Chunk size**: ${wasm.chunkSize.toLocaleString()}`,
    `- **Scanner build**: v${wasm.scannerVersion ?? "unknown"} (${wasm.scannerBuildHash ?? "unknown"})`,
    "",
    "| Implementation | Scan time | Throughput (announcements/sec) | Heap: baseline → peak → final |",
    "| --- | --- | --- | --- |",
    `| Pure-TS reference (\`scanAnnouncementsViewOnly\`) | ${ts.scanMs.toLocaleString()} ms | ${ts.throughputPerSec.toLocaleString()} | ${ts.baselineHeapMb} MB → ${ts.peakHeapMb} MB → ${ts.finalHeapMb} MB |`,
    `| **Rust/WASM (\`scan_announcements_view_only_wasm\`) — what production runs** | ${wasm.scanMs.toLocaleString()} ms | ${wasm.throughputPerSec.toLocaleString()} | ${wasm.baselineHeapMb} MB → ${wasm.peakHeapMb} MB → ${wasm.finalHeapMb} MB |`,
    "",
    `WASM is **${speedup}x** the pure-TS reference throughput on this fixture/machine. The pure-TS scanner exists as a readable reference implementation and a browser fallback when WASM fails to load — the numbers above make clear it is not what most users' scans actually run.`,
    "",
    "Reproduce with: `npm run benchmark:scan` from `sdk/` (runs both implementations and rewrites this block), or individually: `npx tsx scripts/benchmark-scan.ts [fixtureSize] [chunkSize]` (TS) and `npx tsx scripts/benchmark-scan-wasm.ts [fixtureSize] [chunkSize]` (WASM, after building it — see that script's header comment).",
  ].join("\n");

  let content = "";
  try {
    content = fs.readFileSync(readmePath, "utf-8");
  } catch {
    content = "";
  }

  const markerIndex = content.indexOf(marker);
  if (markerIndex === -1) {
    const separator = content.trim().length > 0 ? "\n\n" : "";
    content = `${content}${separator}${block}\n`;
  } else {
    // Replace the existing latest-run block (from the marker to the next
    // top-level heading or end of file) so the README always shows one
    // current result rather than growing unbounded across runs.
    const rest = content.slice(markerIndex);
    const nextHeadingMatch = /\n## /.exec(rest.slice(marker.length));
    const blockEnd =
      nextHeadingMatch != null ? markerIndex + marker.length + nextHeadingMatch.index : content.length;
    content = content.slice(0, markerIndex) + block + "\n" + content.slice(blockEnd);
  }

  fs.mkdirSync(path.dirname(readmePath), { recursive: true });
  fs.writeFileSync(readmePath, content, "utf-8");
  console.log(`[benchmark-scan-report] Results recorded in ${readmePath}`);
}

async function main(): Promise<void> {
  const fixtureSize = process.argv[2] ?? "120000";
  const chunkSize = process.argv[3] ?? "10000";

  ensureWasmNodeBuild();

  run("Run pure-TS reference benchmark", "npx", ["tsx", "scripts/benchmark-scan.ts", fixtureSize, chunkSize]);
  run("Run WASM benchmark", "npx", ["tsx", "scripts/benchmark-scan-wasm.ts", fixtureSize, chunkSize]);

  const tsResult = JSON.parse(fs.readFileSync(path.join(SDK_ROOT, "ts-benchmark-result.json"), "utf-8")) as BenchmarkResult;
  const wasmResult = JSON.parse(
    fs.readFileSync(path.join(SDK_ROOT, "wasm-benchmark-result.json"), "utf-8"),
  ) as BenchmarkResult;

  if (tsResult.fixtureSize !== wasmResult.fixtureSize || tsResult.plantedMatches !== wasmResult.plantedMatches) {
    console.error(
      "[benchmark-scan-report] Fixture mismatch between TS and WASM runs — results are not directly comparable. " +
        "This should not happen since both use the identical buildFixture(); check for a scripts/lib/benchmark-fixture.ts drift.",
    );
    process.exitCode = 1;
    return;
  }

  writeResultsToReadme(tsResult, wasmResult);
}

main().catch((err) => {
  console.error("[benchmark-scan-report] Fatal:", err);
  process.exitCode = 1;
});
