/**
 * Reputation prover — orchestrates witness generation and ZK proof generation
 * for stealth attestations via a dedicated Web Worker.
 *
 * Also provides the on-chain submit helper that calls the
 * ReputationVerifier Soroban contract.
 */

import type { OpaqueWasmModule } from "../hooks/useOpaqueWasm";
import type { ProofData, DiscoveredTrait } from "./reputation";
import { reputationAddresses } from "../contracts/reputationAddresses";
import {
  Account,
  BASE_FEE,
  Contract,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { bytesToScVal, getSorobanServer, invokeContractMethod, u64ToScVal } from "./stellar";
import type { SignTxFn } from "./stellar";
import { getNetworkPassphrase } from "./chain";
import {
  generateV1ProofInWorker,
  ProofGenerationCancelledError,
  type ProofProgressCallback,
} from "./proofWorker/proofWorkerClient";

export type { ProofProgressCallback };
export { ProofGenerationCancelledError };

const REPUTATION_CONTRACT_ID = reputationAddresses.reputationVerifier;
export const MAX_NULLIFIER_BATCH_SIZE = 128;

/**
 * Full proof generation pipeline (runs in a Web Worker):
 * 1. Build witness inputs with circomlibjs Poseidon/BabyJub
 * 2. Generate Groth16 proof via snarkjs
 */
export async function generateReputationProof(
  _wasm: OpaqueWasmModule,
  trait: DiscoveredTrait,
  _allAttestationsJson: string,
  stealthPrivKeyBytes: Uint8Array,
  externalNullifier: string,
  onProgress: ProofProgressCallback,
  signal?: AbortSignal,
): Promise<ProofData> {
  const { proof, publicSignals } = await generateV1ProofInWorker(
    {
      traitAttestationId: trait.attestationId,
      stealthPrivKeyBytes: Array.from(stealthPrivKeyBytes),
      externalNullifier,
    },
    { onProgress, signal },
  );

  // V1 public signal order (canonical — see docs/PUBLIC_SIGNALS.md):
  //   [0] nullifier  [1] is_valid  [2] merkle_root  [3] attestation_id
  //   [4] external_nullifier. Must match circuits/stealth_attestation.circom
  //   and contracts/reputation-verifier.
  const nullifier = publicSignals[0];
  const attestationIdFromProof = Number(publicSignals[3]);
  const isValidSignal = String(publicSignals[1] ?? "0");

  if (isValidSignal !== "1") {
    console.error("❌ [Opaque] Generated proof has is_valid=0.", {
      traitId: trait.attestationId,
      publicSignals,
    });
    throw new Error(
      "Generated proof is invalid (is_valid=0). Rescan traits and regenerate."
    );
  }

  return {
    proof: {
      pi_a: proof.pi_a.slice(0, 2),
      pi_b: proof.pi_b.slice(0, 2),
      pi_c: proof.pi_c.slice(0, 2),
    },
    publicSignals,
    nullifier,
    attestationId: Number.isFinite(attestationIdFromProof) ? attestationIdFromProof : trait.attestationId,
  };
}

// =============================================================================
// On-chain submission (Stellar Soroban)
// =============================================================================

function bigIntToBytes32(val: bigint): Uint8Array {
  const bytes = new Uint8Array(32);
  let n = val;
  for (let i = 31; i >= 0; i--) {
    bytes[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return bytes;
}

/**
 * Fetch the latest valid Merkle root from the on-chain root history
 * by simulating the `get_latest_root` view function on the ReputationVerifier contract.
 */
export async function fetchLatestValidMerkleRoot(sourcePublicKey: string): Promise<Uint8Array> {
  const server = getSorobanServer();
  const passphrase = getNetworkPassphrase();
  const source = await server.getAccount(sourcePublicKey);
  const contract = new Contract(REPUTATION_CONTRACT_ID);
  let tx = new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase: passphrase,
  })
    .addOperation(contract.call("get_latest_root"))
    .setTimeout(30)
    .build();
  tx = await server.prepareTransaction(tx);
  const sim = await server.simulateTransaction(tx);
  if (!("result" in sim) || !sim.result) {
    throw new Error("No valid Merkle root available — contract may not be initialized or root has expired.");
  }
  const retval = sim.result.retval;
  const v = retval as { bytes?: () => Buffer };
  if (!v.bytes) {
    throw new Error("Unexpected response from contract when fetching Merkle root.");
  }
  const rootBytes = Uint8Array.from(v.bytes());
  const isZero = rootBytes.every((b) => b === 0);
  if (isZero) {
    throw new Error("Latest Merkle root is invalid (all zeros).");
  }
  return rootBytes;
}

export async function areNullifiersSpent(
  sourcePublicKey: string,
  ids: Uint8Array[],
): Promise<boolean[]> {
  const results: boolean[] = [];
  const server = getSorobanServer();
  const passphrase = getNetworkPassphrase();
  const contract = new Contract(REPUTATION_CONTRACT_ID);

  for (let offset = 0; offset < ids.length; offset += MAX_NULLIFIER_BATCH_SIZE) {
    const batch = ids.slice(offset, offset + MAX_NULLIFIER_BATCH_SIZE);
    const fakeAccount = new Account(sourcePublicKey, "0");
    const idsScVal = xdr.ScVal.scvVec(
      batch.map((id) => nativeToScVal(Buffer.from(id), { type: "bytes" })),
    );
    const tx = new TransactionBuilder(fakeAccount, {
      fee: BASE_FEE,
      networkPassphrase: passphrase,
    })
      .addOperation(contract.call("are_nullifiers_spent", idsScVal))
      .setTimeout(30)
      .build();

    const sim = await server.simulateTransaction(tx);
    if (!("result" in sim) || !sim.result) {
      throw new Error("Unable to preflight nullifier status.");
    }
    const native = scValToNative(sim.result.retval);
    if (!Array.isArray(native)) {
      throw new Error("Unexpected nullifier batch response.");
    }
    results.push(...native.map(Boolean));
  }

  return results;
}

/**
 * Submits a proof to the ReputationVerifier Soroban contract.
 */
export async function submitProofOnChain(
  proofData: ProofData,
  merkleRoot: string,
  externalNullifier: string,
  signTransaction: SignTxFn,
  publicKey: string,
): Promise<string> {
  const rootBytes = bigIntToBytes32(BigInt(merkleRoot));
  const nullifierBytes = bigIntToBytes32(BigInt(proofData.nullifier));
  const [isSpent] = await areNullifiersSpent(publicKey, [nullifierBytes]);
  if (isSpent) {
    throw new Error("This proof nullifier has already been used on-chain.");
  }

  const pi_a = proofData.proof.pi_a.map(BigInt);
  const pi_b_flat = proofData.proof.pi_b.flatMap((pair) => [BigInt(pair[1]), BigInt(pair[0])]);
  const pi_c = proofData.proof.pi_c.map(BigInt);

  const proofA = new Uint8Array(64);
  proofA.set(bigIntToBytes32(pi_a[0]), 0);
  proofA.set(bigIntToBytes32(pi_a[1]), 32);
  const proofB = new Uint8Array(128);
  for (let i = 0; i < 4; i++) proofB.set(bigIntToBytes32(pi_b_flat[i]), i * 32);
  const proofC = new Uint8Array(64);
  proofC.set(bigIntToBytes32(pi_c[0]), 0);
  proofC.set(bigIntToBytes32(pi_c[1]), 32);

  return invokeContractMethod({
    sourcePublicKey: publicKey,
    contractId: REPUTATION_CONTRACT_ID,
    method: "verify_reputation",
    args: [
      nativeToScVal(publicKey, { type: "address" }),
      nativeToScVal(reputationAddresses.groth16Verifier, { type: "address" }),
      bytesToScVal(proofA),
      bytesToScVal(proofB),
      bytesToScVal(proofC),
      nativeToScVal(Buffer.from(rootBytes), { type: "bytes" }),
      u64ToScVal(proofData.attestationId),
      u64ToScVal(BigInt(externalNullifier)),
      nativeToScVal(Buffer.from(nullifierBytes), { type: "bytes" }),
    ],
    signTransaction,
  });
}
