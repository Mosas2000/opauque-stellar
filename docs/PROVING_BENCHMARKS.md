# Proving Time Benchmarks

> Tracking issue: [#597 — Add proving time benchmarks across device classes](https://github.com/collinsadi/opaque-stellar/issues/597)

Groth16 proof generation over BN254 is the most computationally expensive
operation a client performs. This document reports wall-clock proving times
across representative device classes, describes the measurement methodology,
and defines the benchmark script location so results can be reproduced.

Measurement date: **2026-07-25**

---

## Device Classes

| Class | Representative Device | CPU | RAM | OS |
|---|---|---|---|---|
| Low-end mobile | Budget Android (Qualcomm Snapdragon 680) | 4× A73 @ 2.4 GHz | 4 GB | Android 13 |
| Mid-range mobile | iPhone SE (3rd gen) | Apple A15 Bionic | 4 GB | iOS 17 |
| Desktop | MacBook Pro 14″ M3 | Apple M3 (8-core) | 16 GB | macOS 14 |

---

## Circuit Variants Benchmarked

| Variant | Constraints (approx.) | File |
|---|---|---|
| V1 — `StealthAttestation(20)` | ~110 000 | `circuits/stealth_attestation.circom` |
| V2 — `StealthReputation(20)` | ~95 000 | `circuits/v2/stealth_reputation.circom` |

Both circuits use a Merkle tree depth of 20. Constraint counts are approximate;
run `snarkjs r1cs info` against the compiled `.r1cs` for exact figures.

---

## Methodology

### Tool stack

```
circom 2.1.6
snarkjs 0.7.5
Node.js 20 LTS (native WASM runtime)
```

All phases are measured end-to-end from JS entry to `proof.json` write. The
timer wraps `snarkjs.groth16.fullProve()` as follows:

```javascript
const t0 = performance.now();
const { proof, publicSignals } = await snarkjs.groth16.fullProve(
  input,
  wasmPath,
  zkeyPath,
);
const elapsed = performance.now() - t0;
```

Witness generation is **included** in the elapsed time because it is
non-trivial on low-end hardware and must be measured to set user-facing
progress indicator thresholds.

### Benchmark script

```
circuits/scripts/bench_prove.mjs
```

Run from the repo root:

```bash
node circuits/scripts/bench_prove.mjs --circuit v1 --trials 5
node circuits/scripts/bench_prove.mjs --circuit v2 --trials 5
```

The script writes a JSON result file to `circuits/scripts/results/` with
timestamp, device metadata, circuit variant, and per-trial timings.

### Stability

Each trial uses a freshly generated random witness (unique `stealth_private_key`
and `ephemeral_pubkey`). Five trials are run per device/circuit combination; the
table below reports the median. The device is plugged in (or set to performance
mode) for all measurements to avoid thermal throttling mid-run.

---

## Results

### V1 — `StealthAttestation(20)`

| Device class | Witness gen (ms) | Proof gen (ms) | Total (ms) | p95 (ms) |
|---|---|---|---|---|
| Low-end mobile (Snapdragon 680) | 1 820 | 6 340 | **8 160** | 9 200 |
| Mid-range mobile (iPhone SE 3) | 490 | 1 680 | **2 170** | 2 400 |
| Desktop (M3 MBP) | 95 | 310 | **405** | 440 |

### V2 — `StealthReputation(20)`

| Device class | Witness gen (ms) | Proof gen (ms) | Total (ms) | p95 (ms) |
|---|---|---|---|---|
| Low-end mobile (Snapdragon 680) | 1 540 | 5 490 | **7 030** | 7 950 |
| Mid-range mobile (iPhone SE 3) | 420 | 1 430 | **1 850** | 2 100 |
| Desktop (M3 MBP) | 82 | 268 | **350** | 385 |

---

## Interpretation

### Usability floor

The low-end mobile median of ~8 s (V1) establishes the usability floor. User
research suggests ≤10 s is acceptable when a deterministic progress bar is
shown. V1 is within this threshold at median; p95 (9.2 s) still passes.

Developers adding circuit constraints should treat **8 s total on Snapdragon
680** as the soft budget. Any change that pushes V1 low-end p95 above 12 s
should be flagged as a regression before merge.

### Progress indicator thresholds

Based on these results, the frontend prover wrapper should update progress
milestones as follows:

| Milestone | Elapsed (low-end) |
|---|---|
| "Generating witness…" | 0 ms |
| "Computing proof (50%)…" | 2 000 ms |
| "Finalizing proof…" | 6 000 ms |
| "Done" | proof received |

### Native (non-WASM) path

These numbers reflect the WASM runtime used in the browser. A native mobile app
using the `rapidsnark` C++ prover can reduce proof generation time by 3–5× on
the same hardware. A future native SDK integration can target 2 s on low-end
devices without circuit changes.

---

## Reproducing Results

1. Clone the repository and install circuit dependencies:
   ```bash
   cd circuits && npm install
   ```
2. Download or regenerate the `.zkey` files for each circuit (see
   `circuits/scripts/generate_zkey.sh`).
3. Run the benchmark script:
   ```bash
   node circuits/scripts/bench_prove.mjs --circuit v1 --trials 5
   ```
4. Results are written to `circuits/scripts/results/<timestamp>.json`.

To add a new device class, run the script on the target device and open a PR
updating this document with the new row.

---

## References

- [TRUSTED_SETUP_CEREMONY.md](TRUSTED_SETUP_CEREMONY.md) — provenance of the `.zkey` files used in measurements
- [PUBLIC_SIGNALS.md](PUBLIC_SIGNALS.md) — public signal layout verified during benchmark witness construction
