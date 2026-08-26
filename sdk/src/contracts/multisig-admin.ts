/**
 * Binding for the multisig-admin contract: propose an admin call or a
 * signer-set rotation, approve pending proposals, and read config/proposal
 * state. Every write call's `signer` must be a current on-chain signer and
 * is the tx source; execution happens automatically once a proposal's
 * approval count reaches the configured threshold, so `approve` (and, for a
 * single-signer threshold, `proposeCall`/`proposeRotation` themselves) may
 * cause immediate on-chain execution.
 */
import { xdr } from "@stellar/stellar-sdk";
import type { ContractInvoker } from "../rpc/client";
import type { OpaqueSigner } from "../signer/index";
import { addressToScVal, bytesToScVal, symbolToScVal, u32ToScVal } from "../rpc/scval";

/** Live signer set + approval threshold, as read by `get_config`. */
export interface MultisigConfig {
  signers: string[];
  threshold: number;
}

/** A pending or executed admin action. */
export interface MultisigProposal {
  id: Uint8Array;
  isRotation: boolean;
  target: string;
  fnName: string;
  newSigners: string[];
  newThreshold: number;
  proposer: string;
  approvals: string[];
  executed: boolean;
  createdAt: number;
}

export class MultisigAdmin {
  constructor(
    private readonly rpc: ContractInvoker,
    readonly contractId: string,
  ) {}

  /** Read the deployed contract interface version. */
  async version(source: string): Promise<number> {
    return Number(
      await this.rpc.readNative<number>({
        source,
        contractId: this.contractId,
        method: "version",
        args: [],
      }),
    );
  }

  /** Read the live signer set and approval threshold. */
  async getConfig(source: string): Promise<MultisigConfig> {
    const raw = await this.rpc.readNative<Record<string, unknown>>({
      source,
      contractId: this.contractId,
      method: "get_config",
      args: [],
    });
    return {
      signers: (raw.signers as string[]).map(String),
      threshold: Number(raw.threshold),
    };
  }

  /** Read just the current signer set. */
  async getSigners(source: string): Promise<string[]> {
    const raw = await this.rpc.readNative<unknown[]>({
      source,
      contractId: this.contractId,
      method: "get_signers",
      args: [],
    });
    return raw.map(String);
  }

  /** Read just the current approval threshold. */
  async getThreshold(source: string): Promise<number> {
    return Number(
      await this.rpc.readNative<number>({
        source,
        contractId: this.contractId,
        method: "get_threshold",
        args: [],
      }),
    );
  }

  /** Whether `who` is a current signer. */
  async isSigner(source: string, who: string): Promise<boolean> {
    return Boolean(
      await this.rpc.readNative<boolean>({
        source,
        contractId: this.contractId,
        method: "is_signer",
        args: [addressToScVal(who)],
      }),
    );
  }

  /**
   * Propose invoking `fnName(args)` on `target` — the generic path for any
   * admin operation the multisig governs (publish a root, pause a flow, set
   * a config parameter, transfer admin, ...). `args` are the already-encoded
   * `ScVal`s the target call expects, in order. `signer` must be a current
   * signer. Auto-executes (and this call still just returns the submitting
   * tx hash) if the threshold is 1.
   */
  async proposeCall(opts: {
    target: string;
    fnName: string;
    args: xdr.ScVal[];
    signer: OpaqueSigner;
  }): Promise<string> {
    const proposer = await opts.signer.publicKey();
    return this.rpc.invoke({
      source: proposer,
      contractId: this.contractId,
      method: "propose_call",
      contractPackage: "multisig-admin",
      args: [
        addressToScVal(proposer),
        addressToScVal(opts.target),
        symbolToScVal(opts.fnName),
        xdr.ScVal.scvVec(opts.args),
      ],
      signer: opts.signer,
    });
  }

  /**
   * Propose replacing the contract's own signer set and/or threshold — this
   * contract's self-governance action, going through the same
   * propose/approve/threshold path as {@link proposeCall}.
   */
  async proposeRotation(opts: {
    newSigners: string[];
    newThreshold: number;
    signer: OpaqueSigner;
  }): Promise<string> {
    const proposer = await opts.signer.publicKey();
    return this.rpc.invoke({
      source: proposer,
      contractId: this.contractId,
      method: "propose_rotation",
      contractPackage: "multisig-admin",
      args: [
        addressToScVal(proposer),
        xdr.ScVal.scvVec(opts.newSigners.map(addressToScVal)),
        u32ToScVal(opts.newThreshold),
      ],
      signer: opts.signer,
    });
  }

  /**
   * Approve a pending proposal. Executes automatically once distinct
   * signer approvals reach the configured threshold; use {@link getProposal}
   * after this resolves (or watch for the `Approved` event, whose third
   * field is the execution flag) to check whether it did.
   */
  async approve(opts: { proposalId: Uint8Array; signer: OpaqueSigner }): Promise<string> {
    const signerAddr = await opts.signer.publicKey();
    return this.rpc.invoke({
      source: signerAddr,
      contractId: this.contractId,
      method: "approve",
      contractPackage: "multisig-admin",
      args: [addressToScVal(signerAddr), bytesToScVal(opts.proposalId)],
      signer: opts.signer,
    });
  }

  /** Read a proposal's full state (approvals, execution status, ...). */
  async getProposal(source: string, proposalId: Uint8Array): Promise<MultisigProposal> {
    const raw = await this.rpc.readNative<Record<string, unknown>>({
      source,
      contractId: this.contractId,
      method: "get_proposal",
      args: [bytesToScVal(proposalId)],
    });
    return {
      id: new Uint8Array(raw.id as ArrayLike<number>),
      isRotation: Boolean(raw.is_rotation),
      target: String(raw.target),
      fnName: String(raw.fn_name),
      newSigners: (raw.new_signers as string[]).map(String),
      newThreshold: Number(raw.new_threshold),
      proposer: String(raw.proposer),
      approvals: (raw.approvals as string[]).map(String),
      executed: Boolean(raw.executed),
      createdAt: Number(raw.created_at),
    };
  }

  /**
   * Read the arguments a Call proposal will invoke `fnName` with (empty for
   * a rotation proposal), decoded back to native values.
   */
  async getProposalArgs(source: string, proposalId: Uint8Array): Promise<unknown[]> {
    return this.rpc.readNative<unknown[]>({
      source,
      contractId: this.contractId,
      method: "get_proposal_args",
      args: [bytesToScVal(proposalId)],
    });
  }
}
