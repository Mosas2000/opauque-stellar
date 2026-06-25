import {
  Address,
  BASE_FEE,
  Contract,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";

export type ReadOnlyClientConfig = {
  /** Deployed contract id (C...). */
  contractId: string;
  /** Soroban RPC endpoint, e.g. https://soroban-testnet.stellar.org */
  rpcUrl: string;
  networkPassphrase: string;
  /**
   * Any funded account used as the simulation source. Reads never sign or
   * submit a transaction, so this account's keys are never needed — only
   * its existence on the ledger (to build a valid transaction envelope).
   */
  simulationAccount: string;
};

/**
 * Generic read-only invoker shared by every per-contract client below.
 * Builds, simulates, and decodes a contract call without ever signing or
 * submitting a transaction — integrators don't need to touch XDR directly.
 */
export class ReadOnlyContractClient {
  private readonly contract: Contract;
  private readonly server: rpc.Server;

  constructor(private readonly config: ReadOnlyClientConfig) {
    this.contract = new Contract(config.contractId);
    this.server = new rpc.Server(config.rpcUrl);
  }

  async read<T = unknown>(method: string, args: xdr.ScVal[] = []): Promise<T> {
    const source = await this.server.getAccount(this.config.simulationAccount);
    const tx = new TransactionBuilder(source, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(this.contract.call(method, ...args))
      .setTimeout(30)
      .build();

    const prepared = await this.server.prepareTransaction(tx);
    const sim = await this.server.simulateTransaction(prepared);

    if (rpc.Api.isSimulationError(sim)) {
      throw new Error(`Simulation failed for "${method}": ${sim.error}`);
    }
    const retval = "result" in sim ? sim.result?.retval : undefined;
    if (!retval) {
      throw new Error(`"${method}" returned no value`);
    }
    return scValToNative(retval) as T;
  }
}

export function addressArg(value: string): xdr.ScVal {
  return new Address(value).toScVal();
}

/** Encode a 32-byte hex string (with or without 0x prefix) as a BytesN<32> ScVal. */
export function bytes32Arg(hex: string): xdr.ScVal {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const bytes = Buffer.from(clean, "hex");
  if (bytes.length !== 32) {
    throw new RangeError(`bytes32Arg: expected 32 bytes, got ${bytes.length}`);
  }
  return xdr.ScVal.scvBytes(bytes);
}

export function u32Arg(value: number): xdr.ScVal {
  return nativeToScVal(value, { type: "u32" });
}

export function u64Arg(value: number | bigint): xdr.ScVal {
  return nativeToScVal(value, { type: "u64" });
}

/** Convert a decoded Buffer return value (e.g. BytesN<32>) to a 0x-prefixed hex string. */
export function toHex(value: Buffer | Uint8Array): string {
  return "0x" + Buffer.from(value).toString("hex");
}
