/**
 * Abuse and sanctions policy: public contacts and routes.
 * Keep aligned with docs/ABUSE_AND_SANCTIONS_POLICY.md
 */

export const ABUSE_POLICY_ROUTE = "/abuse-policy";

export const ABUSE_POLICY_REPO_PATH = "docs/ABUSE_AND_SANCTIONS_POLICY.md";
export const OPAQUE_SUPPORT_EMAIL = "support@opaque.cash";
export const OPAQUE_REPO_ISSUES_URL = "https://github.com/collinsadi/opaque-stellar/issues";
export const OPAQUE_REPO_SECURITY_ADVISORY_URL =
  "https://github.com/collinsadi/opaque-stellar/security/advisories/new";

export type ContactChannel = {
  label: string;
  email?: string;
  url?: string;
  urlLabel?: string;
  description: string;
};

/** Public reporting and support contacts */
export const PUBLIC_CONTACTS = {
  abuse: {
    label: "Abuse reports",
    email: OPAQUE_SUPPORT_EMAIL,
    url: OPAQUE_REPO_ISSUES_URL,
    urlLabel: "Open a public GitHub issue",
    description: "Terms violations, sanctions concerns, phishing, impersonation, and misuse of official deployments",
  },
  security: {
    label: "Security incidents",
    email: OPAQUE_SUPPORT_EMAIL,
    url: OPAQUE_REPO_SECURITY_ADVISORY_URL,
    urlLabel: "Open a private security advisory",
    description: "Vulnerabilities, active exploitation, leaked credentials, and safety-critical reports",
  },
  support: {
    label: "General support",
    email: OPAQUE_SUPPORT_EMAIL,
    url: OPAQUE_REPO_ISSUES_URL,
    urlLabel: "Open a public GitHub issue",
    description: "Product bugs and general questions that do not include sensitive victim data",
  },
} as const satisfies Record<string, ContactChannel>;

/** Documented for operators, matches docs/internal/ABUSE_SANCTIONS_RUNBOOK.md */
export const INCIDENT_CONTACTS = {
  incidentEmail: OPAQUE_SUPPORT_EMAIL,
  opsChannel: "#ops-channel (Discord)",
} as const;

export const INFRA_CAN_BLOCK = [
  "Hosted frontend, CDN, DNS, and documentation that we publish or operate",
  "RPC, Horizon, relayer, scanner, or API endpoints we operate, including rate limits and abuse blocks",
  "Payment-link pages, branded pages, or support content hosted on official domains",
  "Issuer attestations, reputation lists, and root publishing where we control the issuer or publisher",
  "Official GitHub issues, advisories, releases, and package distribution channels",
] as const;

export const INFRA_CANNOT_BLOCK = [
  "User XLM in stealth or public Stellar accounts (non-custodial)",
  "Confirmed on-chain transactions (ledger immutability)",
  "Third-party wallet signing (e.g. Freighter)",
  "Stealth recipient deanonymization from protocol design alone",
  "Data already on the public Stellar blockchain",
  "Self-hosted forks of the open-source software",
] as const;

export const REPORTER_PRIVACY_GUARANTEES = [
  "Reports are used only for triage, response, and legal compliance.",
  "Reporter identities are not published without consent, except as required by law.",
  "Anonymous reports are accepted.",
  "Public GitHub issues should not include private victim data, secrets, or doxxing material.",
  "We do not deanonymize blockchain users based on abuse reports alone.",
] as const;

export const ABUSE_ACK_SLA_BUSINESS_DAYS = 5;
