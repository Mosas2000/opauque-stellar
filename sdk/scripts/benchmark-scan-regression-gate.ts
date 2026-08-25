#!/usr/bin/env node
/**
 * WASM scan throughput regression gate (#772).
 *
 * Runs the WASM benchmark at a CI-sized fixture (smaller than the 120k
 * headline number in scanner/README.md, so this stays fast enough to run on
 * every PR) and fails the build if throughput drops below a floor. This is
 * intentionally the WASM path only — WASM is what production actually runs
 * (see scanner/README.md), so a regression here is the one that matters for
 * users; the pure-TS reference implementation has no such gate since it is
 * not on the hot path.
 *
 * The floor is set well below typical measured throughput (see
 * scanner/README.md's "Latest benchmark run" for the current baseline) so
 * normal machine/CI variance doesn't flake the gate — it exists to catch a
 * real regression (e.g. an accidental O(n^2) change, a debug build shipped
 * by mistake), not to enforce a specific number.
 *
 *   npx tsx scripts/benchmark-scan-regression-gate.ts
 */
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SDK_ROOT = path.resolve(__dirname, "..");

// Comfortably below every measured run on CI-class hardware (thousands/sec)
// or a modest developer laptop — see scanner/README.md for current numbers.
// An order-of-magnitude regression (e.g. an accidental fallback to a
// non-vectorized path) trips this; ordinary variance does not.
const MIN_THROUGHPUT_PER_SEC = 500;

// Small enough to run on every PR in a few seconds; large enough that a
// throughput regression isn't lost in fixed per-call overhead.
const CI_FIXTURE_SIZE = 20_000;
const CI_CHUNK_SIZE = 5_000;

function run(cmd: string, args: string[]): void {
  const result = spawnSync(cmd, args, { cwd: SDK_ROOT, stdio: "inherit", env: process.env });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function main(): void {
  console.log(
    `[regression-gate] Running WASM benchmark at CI fixture size (${CI_FIXTURE_SIZE.toLocaleString()})…`,
  );
  run("npx", [
    "tsx",
    "scripts/benchmark-scan-wasm.ts",
    String(CI_FIXTURE_SIZE),
    String(CI_CHUNK_SIZE),
  ]);

  const resultPath = path.join(SDK_ROOT, "wasm-benchmark-result.json");
  const result = JSON.parse(readFileSync(resultPath, "utf-8")) as { throughputPerSec: number };

  console.log(
    `[regression-gate] Measured throughput: ${result.throughputPerSec.toLocaleString()} announcements/sec ` +
      `(floor: ${MIN_THROUGHPUT_PER_SEC.toLocaleString()}/sec)`,
  );

  if (result.throughputPerSec < MIN_THROUGHPUT_PER_SEC) {
    console.error(
      `[regression-gate] FAIL: WASM scan throughput ${result.throughputPerSec.toLocaleString()}/sec is below the ` +
        `${MIN_THROUGHPUT_PER_SEC.toLocaleString()}/sec floor. This indicates a real performance regression in the ` +
        "scanner WASM path — see scanner/README.md's benchmark section for the expected range before investigating.",
    );
    process.exit(1);
  }

  console.log("[regression-gate] PASS");
}

main();
