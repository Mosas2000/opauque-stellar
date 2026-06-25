import { ReadOnlyContractClient, bytes32Arg, toHex, u32Arg, u64Arg } from "../client.js";

export type PendingActionEntry = {
  action: unknown;
  eta_ledger: number;
  executed: boolean;
  cancelled: boolean;
};

/** Typed read methods for the `reputation-verifier` contract. */
export class ReputationVerifierReadClient {
  constructor(private readonly client: ReadOnlyContractClient) {}

  /** Paginated merkle root history (oldest-first), as 0x-prefixed hex strings. */
  async getRootHistory(offset: number, limit: number): Promise<string[]> {
    const history = await this.client.read<Buffer[]>("get_root_history", [
      u32Arg(offset),
      u32Arg(limit),
    ]);
    return history.map(toHex);
  }

  isFrozen(): Promise<boolean> {
    return this.client.read<boolean>("is_frozen");
  }

  lastRootUpdate(): Promise<number> {
    return this.client.read<number>("last_root_update");
  }

  async getLatestRoot(): Promise<string> {
    const root = await this.client.read<Buffer>("get_latest_root");
    return toHex(root);
  }

  /** Configured timelock delay in ledgers (0 = timelock disabled). */
  getTimelockDelay(): Promise<number> {
    return this.client.read<number>("get_timelock_delay");
  }

  getPendingAction(actionId: bigint | number): Promise<PendingActionEntry> {
    return this.client.read<PendingActionEntry>("get_pending_action", [u64Arg(actionId)]);
  }
}

// Re-exported for callers that need to encode a schema/merkle-root id manually.
export { bytes32Arg };
