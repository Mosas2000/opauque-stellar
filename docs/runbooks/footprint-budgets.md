# Soroban Footprint Budgets

Issue: #379 — *Add footprint regression tests for hot contract paths*

Soroban enforces per-invocation CPU instruction, memory, and ledger I/O
limits. As schemas, attestation payloads, and merkle root history grow,
`attest`, `verify_reputation`, and `announce` can approach those limits
without any functional test catching it — functional tests only check
correctness, not resource cost. This document tracks where the footprint
tests live, what they measure, and the worst-case growth path for each
contract call they guard.

## Where the tests live

Each contract's footprint test is a `mod footprint` nested inside its
existing `#[cfg(test)] mod test` block, so it can reuse that module's setup
helpers:

| Hot path | Test | Baseline fixture |
|---|---|---|
| `attest` | `contracts/attestation-engine-v2/src/lib.rs::test::footprint::footprint_attest_within_ceiling` | `ATTEST_CPU_INSNS_CEILING`, `ATTEST_MEM_BYTES_CEILING` |
| `verify_reputation` | `contracts/reputation-verifier/src/lib.rs::test::footprint::footprint_verify_reputation_within_ceiling` | `VERIFY_CPU_INSNS_CEILING`, `VERIFY_MEM_BYTES_CEILING` |
| `announce` | `contracts/stealth-announcer/src/lib.rs::test::footprint::footprint_announce_within_ceiling` | `ANNOUNCE_CPU_INSNS_CEILING`, `ANNOUNCE_MEM_BYTES_CEILING` |

Each test calls `env.budget().reset_default()` immediately before invoking
the measured contract method (so test setup, e.g. schema registration or
root publication, isn't counted), then reads `env.budget().cpu_instruction_cost()`
and `env.budget().memory_bytes_cost()` and asserts both stay at or under the
stored ceiling. CI runs these via the normal `cargo test --workspace` job
(see `.github/workflows/ci.yml`), so a regression that blows the ceiling
fails the build like any other test failure.

## Baseline status

The committed ceilings are an **initial, intentionally generous** budget
recorded against soroban-sdk `25.3.1` pending the first CI run on this
branch. Once CI prints real `cpu_insns`/`mem_bytes` numbers for these three
tests, tighten the constants (e.g. `measured * 1.15`) in a follow-up PR so
the gate catches real regressions rather than only gross blowups. Re-tighten
again any time a deliberate change increases cost — update the constant in
the same PR and note why in the commit message, so the fixture stays a
record of *reviewed* cost, not just the latest number.

## Worst-case paths per contract

- **`attest` (attestation-engine-v2):** cost scales with `data` (the
  encoded attestation payload) and the number of fields in the schema's
  field definitions, which the issuer controls per-call. The tracked
  baseline uses a single short string field; a schema with many fields or a
  large variable-length field is the worst case and should be re-measured
  before raising any per-field or payload-size limits.
- **`verify_reputation` (reputation-verifier):** cost is dominated by the
  cross-contract call into `groth16-verifier`'s `verify_proof`, which this
  test does not exercise (it uses a mock that returns `true`
  unconditionally). The real worst case is the BN254 pairing check in
  `groth16-verifier` — that cost should be tracked in a footprint test in
  `contracts/groth16-verifier`'s own suite, not assumed to be covered here.
  Within `reputation-verifier` itself, cost also scales with
  `get_root_history`'s cap (`MAX_ROOT_HISTORY = 100`), which bounds growth.
- **`announce` (stealth-announcer):** no persistent storage writes, so cost
  is dominated by event payload size (`metadata`, `ephemeral_pub_key`,
  `stealth_address`), which the caller controls per-call. The baseline uses
  the same metadata/key sizes already exercised by this contract's
  functional tests; a much larger metadata blob is the worst case.
