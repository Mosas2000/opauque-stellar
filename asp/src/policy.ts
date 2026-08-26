/**
 * Screening policies. Under the demo policy every testnet deposit is approved
 * (`approveAll`) — this does NOT weaken the trust model (the ASP can never mint or steal),
 * only the screening. Production deployments swap in a real `Policy` via the documented
 * hook (sanctions screening, risk scoring, etc.) returning approve | reject | defer.
 */
import type { Deposit, Policy, PolicyVerdict } from "./types.ts";

/** v1 demo policy: approve every deposit. */
export const approveAll: Policy = {
  name: "approve-all",
  screen(): PolicyVerdict {
    return "approve";
  },
};

/** Allowlist policy: approve listed deposit indices and exclude every unlisted deposit. */
export function allowlist(indices: Iterable<number>): Policy {
  const allowed = new Set(indices);
  return {
    name: "allowlist",
    screen(deposit: Deposit): PolicyVerdict {
      return allowed.has(deposit.index) ? "approve" : "reject";
    },
    reason(deposit: Deposit): string {
      return allowed.has(deposit.index)
        ? "deposit index is present in the operator allowlist"
        : "deposit index is absent from the operator allowlist; see docs/EXCLUSION_APPEAL_PROCESS.md";
    },
  };
}

/**
 * Hook for real screening. Provide an async predicate; deposits it rejects are excluded
 * from the clean set, deposits it can't decide yet are deferred (re-evaluated next tick).
 */
export function screeningPolicy(
  name: string,
  decide: (deposit: Deposit) => Promise<PolicyVerdict> | PolicyVerdict,
): Policy {
  return { name, screen: decide };
}
