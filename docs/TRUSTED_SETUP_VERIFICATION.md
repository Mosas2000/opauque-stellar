# Verify the Production zk Setup (Trusted Setup) Yourself

> Tracking issue: [#487 — Add ZK trusted setup verification instructions for users](https://github.com/collinsadi/opaque-stellar/issues/487)
>
> Background: [TRUSTED_SETUP_CEREMONY.md](TRUSTED_SETUP_CEREMONY.md) (how the
> ceremony is run and what is published). **Linked from the reputation settings
> in the reference frontend.**

Advanced users should not have to *trust* the team's word that the proving/verifying
keys in production are the ones produced by the signed ceremony. This guide shows
how to independently verify a production `zkey` (and its `verification_key.json`)
against the **signed ceremony transcript** using only open-source tools. Every
command below runs fully offline once you have the artifacts.

The guarantees you are checking:

1. **Hash match** — the production `zkey` you (or the frontend) are using
   hashes to the value recorded in the signed ceremony transcript's
   `checksums.sha256`.
2. **Structural validity** — the `zkey` is a valid Groth16 key for the published
   `.r1cs` and phase-2 `.ptau` (no tampering / wrong circuit).
3. **Signed provenance** — each contributor's `zkey` is PGP-signed, and the final
   beacon is taken from a public, unpredictable source.
4. **Manifest consistency** — the hash matches the value pinned in the deployment
   manifest (`deployments/v1/<network>.json`) and `artifacts/manifest.json`.

---

## 0. Prerequisites (all open-source)

```bash
# node + npm (for snarkjs) and standard CLI hashing tools
node --version          # any recent LTS
npm install -g snarkjs  # or: npx snarkjs <cmd>
which sha256sum gpg     # sha256sum (coreutils), gpg (GnuPG)
git clone https://github.com/collinsadi/opaque-stellar.git
cd opaque-stellar
```

> No proprietary tooling, no remote calls, and no trust in a hosted verifier are
> required. `snarkjs` is the same open tool used to *run* the ceremony, so you
> are re-deriving the ceremony's own checks.

---

## 1. Obtain the artifacts you will verify

You need three things, all published in the ceremony transcript and/or release
assets:

| Artifact | Where it lives | What it proves |
| --- | --- | --- |
| `stealth_attestation_final.zkey` | `circuits/ceremony/` (transcript) or release `artifacts/` | The proving key actually used |
| `verification_key.json` | `circuits/ceremony/final_vk.json` or release `artifacts/` | The on-chain VK source |
| `circuits/ceremony/checksums.sha256` | transcript root | Signed record of expected hashes |
| `stealth_attestation.r1cs` + `pot17_final.ptau` | `circuits/build/production/` (or phase-1 source) | Circuit + powers-of-tau the zkey must match |

If you downloaded the `zkey` from the production frontend CDN, fetch the *same*
file locally so you can compare its hash to the transcript.

---

## 2. Verify the zkey hash matches the signed transcript

The transcript's `checksums.sha256` is committed to the repo and (for a real
ceremony) each line is covered by a contributor's PGP signature. Compute the
hash of your `zkey` and compare:

```bash
sha256sum circuits/ceremony/stealth_attestation_final.zkey
# -> <hash>  circuits/ceremony/stealth_attestation_final.zkey

# Confirm that exact hash appears in the signed checksums file:
grep -i "stealth_attestation_final.zkey" circuits/ceremony/checksums.sha256
```

**Expected result:** the two hashes are identical. If they differ, stop — the
key you have is not the one the ceremony produced.

Optionally verify the PGP signatures on the transcript itself:

```bash
# In circuits/ceremony/attestations/
gpg --verify 01_<handle>.md.sig 01_<handle>.md   # repeats per contributor
```

A valid signature means the contributor attests they published that exact
`.zkey` and destroyed their randomness (per the attestation template).

---

## 3. Verify the zkey is structurally valid (open-tool check)

`snarkjs zkey verify` re-derives the ceremony's own validation: it confirms the
final `zkey` is a correct Groth16 key for the given `.r1cs` and phase-2 `.ptau`,
i.e. it was produced by the documented contribution chain and not swapped for a
different circuit.

```bash
snarkjs zkey verify \
  circuits/build/production/stealth_attestation.r1cs \
  circuits/build/production/pot17_final.ptau \
  circuits/ceremony/stealth_attestation_final.zkey
# -> [INFO] zkey...
# -> [INFO] Verification succeed!
```

**Expected result:** `Verification succeed!`. A failure means the `zkey` does not
correspond to the published circuit/ptau and must not be trusted.

You can also export and hash the verification key and confirm *it* matches the
transcript:

```bash
snarkjs zkey export verificationkey \
  circuits/ceremony/stealth_attestation_final.zkey \
  /tmp/verification_key.json

sha256sum /tmp/verification_key.json
grep -i "verification_key.json" circuits/ceremony/checksums.sha256
```

---

## 4. Verify the beacon is public and unpredictable

The final contribution is a **beacon** — a hash of a future, public block
(e.g. an Ethereum block hash announced ≥24h in advance). Confirm the beacon in
`circuits/ceremony/beacon.txt` matches a real, published block:

```bash
cat circuits/ceremony/beacon.txt
# -> Block N, hash 0x..., timestamp ...
# Cross-check against a public block explorer / Ethereum JSON-RPC eth_getBlockByNumber
```

Because the block hash was unknowable when contributions started, no participant
could have pre-computed it to bias the final key — this is what lets a single
honest participant secure the whole ceremony.

---

## 5. Confirm the hash matches the deployment manifest

The production deployment pins the expected key hashes so the frontend/on-chain
verifier cannot be pointed at a different key silently.

```bash
# The deployment manifest records the expected zkey / VK hashes:
jq '.zkey_sha256, .vk_hash' deployments/v1/<network>.json
# (for the initial production rollover these live alongside the registry's
#  verifier registration; see TRUSTED_SETUP_CEREMONY.md § Key Rollover)

# The frontend/SDK consume hash-pinned artifacts:
jq '.circuits' artifacts/manifest.json
```

**Expected result:** these hashes equal the `sha256sum` you computed in §2–§3.
If the manifest's pinned hash differs from the transcript's signed hash, that is
a supply-chain discrepancy — report it via a private security advisory
(SECURITY.md), not a public issue.

---

## 6. (Optional) Full transcript verification script

If the ceremony coordinator published `circuits/scripts/verify_ceremony.mjs`,
it performs §2–§5 in one pass (contiguous zkey chain, per-contribution hashes,
beacon block match, VK hash match) with no network dependencies:

```bash
node circuits/scripts/verify_ceremony.mjs \
  --r1cs circuits/build/production/stealth_attestation.r1cs \
  --ptau circuits/build/production/pot17_final.ptau \
  --ceremony-dir circuits/ceremony/ \
  --final-zkey circuits/ceremony/stealth_attestation_final.zkey
# -> ✓ ceremony valid
```

If that script is not present in your checkout, the manual steps above are the
complete, tool-for-tool equivalent.

---

## 7. What "verified" means (and doesn't)

- ✅ **Verified** means: the `zkey`/`vk` you hold hash-match the signed
  transcript, are structurally valid for the published circuit, and the beacon
  was public. Under the 1-of-N honest-participant assumption
  (TRUSTED_SETUP_CEREMONY.md), this is strong evidence the setup is sound.
- ⚠️ **Not covered here:** the *correctness* of the circuit's constraints (that
  the circuit proves what we claim). That is a separate audit/soundness concern
  — see `docs/CIRCUIT_SOUNDNESS_CHECKLIST.md`.

If every step above passes, you have independently confirmed the production
trusted setup without trusting any hosted service.
