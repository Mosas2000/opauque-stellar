/**
 * On-chain ZK reputation. Submit a V2 Groth16 proof to the reputation-verifier
 * (root validity + nullifier-replay enforced on-chain), read the latest published
 * root, and attest (delegated to the schema service). Proof generation requires
 * an artifact resolver (snarkjs + circuit artifacts); use {@link prove} or
 * {@link proveAndVerify} when configured, or bring a precomputed proof to
 * {@link verifyOnChain}.
 */
import { NotWiredError } from "../errors/index";
import type { VerifyReputationInputs } from "../contracts/verifier";
import {
  proveReputationV2,
  type ReputationProof,
  type ReputationProveInput,
} from "../prove/reputation";
import type { OpaqueClientContext } from "./context";
import type { SchemasService } from "./schemas";

export class ReputationService {
  constructor(
    private readonly ctx: OpaqueClientContext,
    private readonly schemas: SchemasService,
  ) {}

  /** Attest a reputation trait to a stealth identity (delegates to schemas). */
  attest(opts: Parameters<SchemasService["attest"]>[0]): Promise<string> {
    return this.schemas.attest(opts);
  }

  /** Submit a precomputed V2 reputation proof for on-chain verification. */
  async verifyOnChain(opts: VerifyReputationInputs): Promise<string> {
    const signer = this.ctx.requireSigner();
    return this.ctx.contracts.reputationVerifier.verifyReputation({
      ...opts,
      groth16VerifierId: this.ctx.config.contracts.groth16Verifier,
      signer,
    });
  }

  /** Read the latest published reputation Merkle root, or null if none. */
  async getLatestRoot(opts?: { source?: string }): Promise<Uint8Array | null> {
    const source = opts?.source ?? (await this.ctx.requireSigner().publicKey());
    return this.ctx.contracts.reputationVerifier.getLatestRoot(source);
  }

  /**
   * Generate a V2 reputation proof. Requires an artifact resolver
   * (`new OpaqueClient({ artifacts })`); otherwise throws {@link NotWiredError}.
   */
  async prove(input: ReputationProveInput): Promise<ReputationProof> {
    if (!this.ctx.artifacts) {
      throw new NotWiredError(
        "Reputation proof generation",
        "Construct OpaqueClient with { artifacts } (a circuit ArtifactResolver) to enable proving.",
      );
    }
    return proveReputationV2({ input, artifacts: this.ctx.artifacts });
  }

  /** Generate a proof and submit it on-chain in one call. Returns the tx hash. */
  async proveAndVerify(input: ReputationProveInput): Promise<string> {
    return this.verifyOnChain(await this.prove(input));
  }
}
