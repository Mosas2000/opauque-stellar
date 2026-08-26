/**
 * Canonical deployment manifest registry.
 */

import testnetManifest from "./v1/testnet.json" with { type: "json" };
import mainnetManifest from "./v1/mainnet.json" with { type: "json" };
import type { DeploymentManifestV1, DeploymentNetwork } from "./types.js";

export const DEPLOYMENT_MANIFESTS: Record<
  DeploymentNetwork,
  DeploymentManifestV1
> = {
  testnet: testnetManifest as DeploymentManifestV1,
  mainnet: mainnetManifest as DeploymentManifestV1,
};

export function getDeploymentManifest(
  network: DeploymentNetwork,
): DeploymentManifestV1 {
  return DEPLOYMENT_MANIFESTS[network];
}

export * from "./types.js";
export function resolveDeploymentNetwork(raw = "testnet"): DeploymentNetwork {
  const network = raw.trim().toLowerCase();
  if (network !== "testnet" && network !== "mainnet") {
    throw new Error(`unsupported network "${raw}"; expected testnet or mainnet`);
  }
  return network;
}

export function requireDeployedContract(
  manifest: DeploymentManifestV1,
  key: string,
  service: string,
): string {
  const record = (manifest.contracts as Record<string, { id?: string | null } | undefined>)[key];
  const id = record?.id?.trim();
  if (manifest.deploymentStatus !== "deployed" || !id) {
    throw new Error(
      `${service} cannot start on ${manifest.network}: ${key} is not deployed in deployments/v1/${manifest.network}.json`,
    );
  }
  return id;
}