import { ReadOnlyContractClient, bytes32Arg } from "../client.js";

export type Attestation = {
  uid: Buffer;
  schema_id: Buffer;
  issuer: string;
  stealth_address_hash: Buffer;
  data: Buffer;
  created_at: number;
  expiration_ledger: number;
  revocation_ledger: number;
  ref_uid: Buffer;
  issuance_sequence: bigint;
};

export type GovernanceConfig = {
  admin: string;
  governance: string;
  schema_registry: string;
  version: number;
  paused_attestation: boolean;
  paused_merkle_updates: boolean;
  paused_proof_verification: boolean;
  upgrade_info: unknown;
};

/** Typed read methods for the `attestation-engine-v2` contract. */
export class AttestationEngineReadClient {
  constructor(private readonly client: ReadOnlyContractClient) {}

  getAttestation(uid: string): Promise<Attestation> {
    return this.client.read<Attestation>("get_attestation", [bytes32Arg(uid)]);
  }

  getConfig(): Promise<GovernanceConfig> {
    return this.client.read<GovernanceConfig>("get_config");
  }

  /** Resolves if merkle root updates are active; throws the contract's Paused error otherwise. */
  checkMerkleUpdatesActive(): Promise<void> {
    return this.client.read<void>("check_merkle_updates_active");
  }

  /** Resolves if proof verification is active; throws the contract's Paused error otherwise. */
  checkProofVerificationActive(): Promise<void> {
    return this.client.read<void>("check_proof_verification_active");
  }
}
