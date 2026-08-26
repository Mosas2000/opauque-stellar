/**
 * Mainnet security audit status: aligned with deployments/security/mainnet-audit-findings.json
 */

export const SECURITY_AUDIT_DOCS = {
  scope: "deployments/security/MAINNET_AUDIT_SCOPE.md",
  report: "deployments/security/MAINNET_AUDIT_REPORT.md",
  signoff: "deployments/security/MAINNET_AUDIT_SIGNOFF.md",
  findings: "deployments/security/mainnet-audit-findings.json",
} as const;

export const MAINNET_AUDIT_COMPONENTS = [
  "Soroban contracts (6 packages)",
  "ZK circuits (v1/v2)",
  "Scanner WASM (opauque-scanner)",
  "Frontend key handling",
  "Deployment operations",
] as const;

export type MainnetSignoffStatus = "blocked" | "approved";

/** Current signoff status from findings register (update when JSON changes). */
export const MAINNET_SIGNOFF_STATUS: MainnetSignoffStatus = "blocked";

export const OPEN_BLOCKING_FINDING_IDS: readonly string[] = [
  "SEC-001",
  "SEC-002",
  "SEC-003",
  "SEC-004",
];

export function isMainnetAuditApproved(): boolean {
  return MAINNET_SIGNOFF_STATUS === "approved";
}

export function isMainnetDeployAllowedByAudit(): boolean {
  return isMainnetAuditApproved() && OPEN_BLOCKING_FINDING_IDS.length === 0;
}
