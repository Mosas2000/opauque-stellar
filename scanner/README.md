# Scanner Engine

Rust/WASM implementation of the DKSAP (EIP-5564-style) stealth-address scanner:
view-tag prefiltering, stealth-address derivation, and attestation matching for
the Opaque Cash protocol. Compiled via `wasm-bindgen` and consumed by the
frontend/SDK through the generated bindings in `src/lib.rs`.

See `src/scanner.rs` for the core DKSAP math and `src/attestation.rs` for
reputation-attestation scanning.

## Performance

### Concurrent announcement fetching (#603)

The frontend's `useScanner` hook (`frontend/src/hooks/useScanner.ts`) fetches
announcement pages from the chain with bounded concurrency
(`DEFAULT_FETCH_CONCURRENCY`, default 4 concurrent `getEvents` calls) instead
of one page at a time, while still delivering pages to callers in strict
ascending order — cache writes, sync-state updates, and progress reporting
see identical results to the previous fully-sequential implementation.

### Large-scale scan benchmark (#604, WASM added by #772)

A deterministic synthetic fixture (default 120,000 announcements, seeded
PRNG, shared by both benchmarks via `sdk/scripts/lib/benchmark-fixture.ts`)
is run through **both** scanner implementations and reported side by side:

- `sdk/scripts/benchmark-scan.ts` — the pure-TS reference scanner
  (`scanAnnouncementsViewOnly`). Exists as a readable reference and a
  browser fallback when WASM fails to load.
- `sdk/scripts/benchmark-scan-wasm.ts` — the compiled Rust/WASM scanner
  (`scan_announcements_view_only_wasm`), **what the frontend and production
  actually run**.

Run both and update the numbers below in one command, from `sdk/`:

```bash
npm run benchmark:scan
# or with an explicit fixture/chunk size:
npx tsx scripts/benchmark-scan-report.ts 200000 10000
```

This builds the scanner WASM for the `nodejs` wasm-pack target automatically
on first run (a separate build from the `web`-target one the frontend uses —
see `benchmark-scan-wasm.ts`'s header comment). To run just one
implementation: `npm run benchmark:scan:ts` or `npm run benchmark:scan:wasm`.

A CI job (`scanner-benchmark-gate` in `.github/workflows/ci.yml`) runs the
WASM benchmark at a smaller fixture size on every PR and fails the build if
throughput regresses below a floor — see
`sdk/scripts/benchmark-scan-regression-gate.ts`.

Results are written below automatically each time the script runs.

<!-- benchmark-scan:latest -->
### Latest benchmark run

- **Run at**: 2026-08-25T14:39:26.927Z
- **Fixture size**: 120,000 announcements (24 planted true positives; both implementations verified 24/24 matches found)
- **Chunk size**: 10,000
- **Scanner build**: v0.1.0 (unknown)

| Implementation | Scan time | Throughput (announcements/sec) | Heap: baseline → peak → final |
| --- | --- | --- | --- |
| Pure-TS reference (`scanAnnouncementsViewOnly`) | 360,150 ms | 333 | 115.3 MB → 131.9 MB → 80 MB |
| **Rust/WASM (`scan_announcements_view_only_wasm`) — what production runs** | 18,583 ms | 6,457 | 103.5 MB → 109.2 MB → 79.6 MB |

WASM is **19.39x** the pure-TS reference throughput on this fixture/machine. The pure-TS scanner exists as a readable reference implementation and a browser fallback when WASM fails to load — the numbers above make clear it is not what most users' scans actually run.

Reproduce with: `npm run benchmark:scan` from `sdk/` (runs both implementations and rewrites this block), or individually: `npx tsx scripts/benchmark-scan.ts [fixtureSize] [chunkSize]` (TS) and `npx tsx scripts/benchmark-scan-wasm.ts [fixtureSize] [chunkSize]` (WASM, after building it — see that script's header comment).

## Memory & responsiveness (frontend)

- **WASM memory exhaustion handling (#605)**: `frontend/src/workers/scannerWorker.ts`
  monitors JS heap usage (via `performance.memory` where available, with a
  hard iteration-count fallback on engines that don't expose it) during a
  scan and aborts cleanly with a resumable cursor rather than letting the
  WASM module trap on an out-of-memory condition. See
  `shouldAbortForMemoryPressure` and `MEMORY_PRESSURE_RATIO`.
- **Web worker offloading (#606)**: the same worker moves trial decryption
  (view-tag + full stealth-address match checks) off the main thread, wired
  into `PrivateBalanceView` via `frontend/src/hooks/useScannerWorker.ts`.
  Progress messages are rate-limited (`progressIntervalMs`, default 150ms) so
  the UI isn't flooded with updates on large histories.
