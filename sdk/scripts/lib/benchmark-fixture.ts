/**
 * Shared deterministic fixture generator for the scan benchmarks (#772).
 *
 * Extracted from `benchmark-scan.ts` so the TS-reference benchmark and the
 * WASM benchmark (`benchmark-scan-wasm.ts`) drive the *identical* fixture —
 * same seed, same planted-match density, same announcement bytes — making
 * their throughput numbers directly comparable rather than each generating
 * its own similar-but-not-identical dataset.
 */
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { deriveKeysFromSignature, keysToStealthMetaAddress } from "../../src/crypto/dksap";
import type { StealthAnnouncement } from "../../src/crypto/scan";
import { bytesToHex } from "../../src/crypto/bytes";

const CURVE = secp256k1;
const N = CURVE.CURVE.n;

// ---------------------------------------------------------------------------
// Deterministic PRNG (mulberry32) — same seed always produces the same
// fixture, so benchmark runs are comparable across machines and over time.
// ---------------------------------------------------------------------------
function mulberry32(seed: number): () => number {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIXTURE_SEED = 0xc0ffee;

function randomScalar(prng: () => number): bigint {
  // 8 x 32-bit words -> 256-bit candidate, rejection-sampled against the
  // curve order so every scalar this produces is a valid private key.
  while (true) {
    let hex = "";
    for (let i = 0; i < 8; i++) {
      hex += Math.floor(prng() * 0x100000000)
        .toString(16)
        .padStart(8, "0");
    }
    const candidate = BigInt("0x" + hex);
    if (candidate > 0n && candidate < N) {
      return candidate;
    }
  }
}

function scalarToBytes32(s: bigint): Uint8Array {
  const hex = s.toString(16).padStart(64, "0");
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

/** Real DKSAP derivation (sender side), mirroring `computeStealthAddressAndViewTag`
 * but with a caller-supplied (here: deterministically seeded) ephemeral key
 * instead of OS randomness, so planted true-positive fixtures are reproducible. */
function deriveAnnouncement(
  ephemeralPriv: Uint8Array,
  viewPubKey: Uint8Array,
  spendPubKey: Uint8Array,
): { ephemeralPubKey: Uint8Array; stealthAddress: string; viewTag: number } {
  const ephemeralPubKey = CURVE.getPublicKey(ephemeralPriv, true);
  const ephScalar = BigInt("0x" + bytesToHex(ephemeralPriv)) % N;
  const viewPoint = CURVE.ProjectivePoint.fromHex(viewPubKey);
  const shared = viewPoint.multiply(ephScalar).toRawBytes(true);
  const sH = keccak_256(shared);
  const viewTag = sH[0];
  const sHScalar = BigInt("0x" + bytesToHex(sH)) % N;
  const sHPoint = CURVE.ProjectivePoint.BASE.multiply(sHScalar);
  const spendPoint = CURVE.ProjectivePoint.fromHex(spendPubKey);
  const stealthPoint = spendPoint.add(sHPoint);
  const uncompressed = stealthPoint.toRawBytes(false);
  const addressHash = keccak_256(uncompressed.slice(1));
  const stealthAddress = "0x" + bytesToHex(addressHash.slice(12));
  return { ephemeralPubKey, stealthAddress, viewTag };
}

export interface Fixture {
  announcements: StealthAnnouncement[];
  plantedCount: number;
  viewingKey: Uint8Array;
  spendingPubKey: Uint8Array;
}

/**
 * Builds a deterministic fixture of `size` announcements. `plantEvery`
 * controls the density of real matches planted among the noise (e.g. 5000 ->
 * ~size/5000 genuine matches for a correctness cross-check alongside the
 * throughput numbers).
 */
export function buildFixture(size: number, plantEvery = 5000): Fixture {
  const prng = mulberry32(FIXTURE_SEED);
  const { viewingKey, spendingKey } = deriveKeysFromSignature("0x" + "ab".repeat(64));
  const { V: viewPubKey, S: spendPubKey } = keysToStealthMetaAddress(viewingKey, spendingKey);

  const announcements: StealthAnnouncement[] = new Array(size);
  let plantedCount = 0;

  for (let i = 0; i < size; i++) {
    const ephemeralPriv = scalarToBytes32(randomScalar(prng));

    if (i % plantEvery === 0) {
      // Planted true positive: derived for this recipient's real keys.
      const { ephemeralPubKey, stealthAddress, viewTag } = deriveAnnouncement(
        ephemeralPriv,
        viewPubKey,
        spendPubKey,
      );
      announcements[i] = { stealthAddress, ephemeralPubKey, viewTag };
      plantedCount += 1;
    } else {
      // Noise: a structurally valid announcement (real curve point for the
      // ephemeral key, since the scanner does real point arithmetic on it)
      // that is not addressed to this recipient.
      const ephemeralPubKey = CURVE.getPublicKey(ephemeralPriv, true);
      const viewTag = Math.floor(prng() * 256);
      const addrBytes = new Uint8Array(20);
      for (let b = 0; b < 20; b++) addrBytes[b] = Math.floor(prng() * 256);
      announcements[i] = {
        stealthAddress: "0x" + bytesToHex(addrBytes),
        ephemeralPubKey,
        viewTag,
      };
    }
  }

  return { announcements, plantedCount, viewingKey, spendingPubKey: spendPubKey };
}

export function heapMb(): number {
  return process.memoryUsage().heapUsed / (1024 * 1024);
}

export function formatMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms.toFixed(1)} ms`;
}
