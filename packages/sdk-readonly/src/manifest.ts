/**
 * Minimal mirror of the monorepo's `deployments/types.ts` shape, kept
 * dependency-free so this package can be published standalone. If the
 * upstream manifest schema changes, update both in lockstep.
 */
export type ContractKey =
  | "stealthRegistry"
  | "stealthAnnouncer"
  | "groth16Verifier"
  | "reputationVerifier"
  | "schemaRegistry"
  | "attestationEngineV2";

export type ContractRecord = {
  id: string;
  wasmHash: string;
  package?: string;
};

export type DeploymentManifest = {
  schemaVersion: string;
  network: "testnet" | "mainnet";
  networkPassphrase: string;
  rpcUrl?: string;
  contracts: Record<ContractKey, ContractRecord>;
};

/** Resolve a deployed contract id for `key` out of a manifest, or throw. */
export function contractIdFromManifest(
  manifest: DeploymentManifest,
  key: ContractKey,
): string {
  const id = manifest.contracts[key]?.id;
  if (!id) {
    throw new Error(
      `No deployed contract id for "${key}" in manifest (network=${manifest.network})`,
    );
  }
  return id;
}
