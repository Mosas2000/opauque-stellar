import { ReadOnlyContractClient, addressArg, toHex, u64Arg } from "../client.js";

/** Typed read methods for the `stealth-registry` contract. */
export class StealthRegistryReadClient {
  constructor(private readonly client: ReadOnlyContractClient) {}

  /** Current stealth meta-address for `registrant` under `schemeId`, or null if unregistered. */
  async resolve(registrant: string, schemeId: bigint | number): Promise<string | null> {
    const bytes = await this.client.read<Buffer | null>("resolve", [
      addressArg(registrant),
      u64Arg(schemeId),
    ]);
    return bytes ? toHex(bytes) : null;
  }

  /** Stealth meta-address for `registrant` at a specific `nonce`, or null if not found. */
  async resolveHistorical(
    registrant: string,
    schemeId: bigint | number,
    nonce: bigint | number,
  ): Promise<string | null> {
    const bytes = await this.client.read<Buffer | null>("resolve_historical", [
      addressArg(registrant),
      u64Arg(schemeId),
      u64Arg(nonce),
    ]);
    return bytes ? toHex(bytes) : null;
  }
}
