/**
 * Privacy pool. Deposit (derive a note's commitment and persist the note),
 * sweep a stealth account straight into a deposit, withdraw with a
 * precomputed proof, and read pool state (deposit count, roots).
 * Withdrawal proof *generation* needs the proving layer (snarkjs + circuit
 * artifacts) and is surfaced as a not-wired capability in this build: bring a
 * precomputed proof bundle to withdraw().
 */
import {
  bigIntToBytes32,
  deriveDeposit,
  deriveStealthStellarKeypairFromStealthPrivKey,
  newNoteSecrets,
  parseXlmToStroops,
  toHex32,
  type PoolNote,
} from "../crypto/index";
import { NotWiredError } from "../errors/index";
import { provePoolWithdraw, type PoolWithdrawProof } from "../prove/pool";
import type { SimulationReport } from "../rpc/client";
import type { OpaqueSigner } from "../signer/index";
import { keypairSigner } from "../signer/index";
import { validateDepositAmount } from "./pool-validation";
import type { OpaqueClientContext } from "./context";

/** A withdrawal proof bundle (everything except the public recipient/fee/relayer). */
export type WithdrawProofBundle = PoolWithdrawProof;

export class PoolService {
  constructor(private readonly ctx: OpaqueClientContext) {}

  private async source(explicit?: string): Promise<string> {
    return explicit ?? (await this.ctx.requireSigner().publicKey());
  }

  /**
   * Deposit `amountXlm` into the pool. Reads the next leaf index, derives the
   * commitment from fresh (or provided) secrets, submits, and persists the note.
   */
  async deposit(opts: {
    amountXlm: string;
    secrets?: { nullifier: string; secret: string };
    createdAt?: number;
    /** Skip the pre-flight amount validation (default false). */
    skipValidation?: boolean;
  }): Promise<{ note: PoolNote; txHash: string }> {
    const signer = this.ctx.requireSigner();
    const value = parseXlmToStroops(opts.amountXlm);
    return this.depositWithSigner({
      signer,
      value,
      amountXlmForValidation: opts.amountXlm,
      secrets: opts.secrets,
      createdAt: opts.createdAt,
      skipValidation: opts.skipValidation,
    });
  }

  /**
   * Fund a pool deposit straight from a discovered stealth account, without
   * the connected wallet ever signing — the stealth account (derived from
   * `stealthPrivKey`) is the depositor, tx source, and fee payer. This is the
   * README's flagship "sweep into the pool" flow: the resulting note is
   * indistinguishable from any other pool deposit, and shares this class's
   * exact deposit/note-persistence path via {@link depositWithSigner}.
   *
   * `amountStroops` should be the stealth account's spendable balance minus a
   * fee buffer (compute it however the caller sources balances — e.g. via
   * Horizon) — this method does not itself query or reserve for fees.
   */
  async sweep(opts: {
    stealthPrivKey: Uint8Array;
    amountStroops: bigint;
    secrets?: { nullifier: string; secret: string };
    createdAt?: number;
    /** Skip the pre-flight amount validation (default false). */
    skipValidation?: boolean;
  }): Promise<{ note: PoolNote; txHash: string }> {
    const keypair = deriveStealthStellarKeypairFromStealthPrivKey(opts.stealthPrivKey);
    return this.depositWithSigner({
      signer: keypairSigner(keypair),
      value: opts.amountStroops,
      // No user-typed decimal string exists for a sweep; stringifying the
      // integer stroop amount still exercises the non-positive /
      // exceeds-field-modulus checks (an integer has 0 fractional digits, so
      // the precision check never fires against it).
      amountXlmForValidation: opts.amountStroops.toString(),
      secrets: opts.secrets,
      createdAt: opts.createdAt,
      skipValidation: opts.skipValidation,
    });
  }

  /** Shared deposit path: derive the commitment, submit, and persist the note. */
  private async depositWithSigner(opts: {
    signer: OpaqueSigner;
    value: bigint;
    amountXlmForValidation: string;
    secrets?: { nullifier: string; secret: string };
    createdAt?: number;
    skipValidation?: boolean;
  }): Promise<{ note: PoolNote; txHash: string }> {
    const source = await opts.signer.publicKey();
    const scope = this.ctx.config.pool.scope;
    const value = opts.value;

    if (!opts.skipValidation) {
      const decimals = await this.ctx.contracts.privacyPool.getNativeAssetDecimals(source);
      validateDepositAmount({ amountXlm: opts.amountXlmForValidation, valueStroops: value, decimals });
    }

    const expectedIndex = await this.ctx.contracts.privacyPool.getDepositCount(source);
    const secrets = opts.secrets ?? newNoteSecrets();
    const { commitment } = await deriveDeposit({
      value,
      scope,
      leafIndex: expectedIndex,
      nullifier: BigInt(secrets.nullifier),
      secret: BigInt(secrets.secret),
    });

    const txHash = await this.ctx.contracts.privacyPool.deposit({
      value,
      commitment: bigIntToBytes32(commitment),
      expectedIndex,
      signer: opts.signer,
    });

    const note: PoolNote = {
      cluster: this.ctx.config.network,
      poolId: this.ctx.config.contracts.privacyPool,
      value: value.toString(),
      scope,
      leafIndex: expectedIndex,
      nullifier: secrets.nullifier,
      secret: secrets.secret,
      commitment: toHex32(commitment),
      spent: false,
      createdAt: opts.createdAt ?? 0,
    };
    await this.ctx.notes.add(note);
    return { note, txHash };
  }

  /**
   * Withdraw using a precomputed proof bundle. Marks the note spent **only after**
   * the on-chain withdrawal is confirmed successful.
   *
   * Fault safety: {@link PrivacyPool.withdraw} resolves only once the transaction
   * has been polled to a `SUCCESS` result, so any fault before that point (a
   * network error before submission, an RPC error/timeout during submission, or a
   * lost confirmation after submission) rejects here and the note is left
   * **unspent** — a note is never burned for a withdrawal that did not land.
   *
   * The remaining ambiguous window is a submission that actually landed on-chain
   * but whose confirmation was lost client-side: the note stays locally unspent,
   * yet a naive retry cannot double-pay because the pool rejects the reused
   * nullifier ({@link ContractError} `NullifierUsed`). Use
   * {@link reconcileWithdrawal} (or {@link isNullifierSpent}) to reconcile local
   * note state with on-chain truth after such a failure.
   */
  async withdraw(opts: {
    proof: WithdrawProofBundle;
    recipient: string;
    fee?: bigint;
    relayer?: string;
    /** Note commitment to mark spent once the withdrawal lands. */
    noteCommitment?: string;
  }): Promise<string> {
    const signer = this.ctx.requireSigner();
    const txHash = await this.ctx.contracts.privacyPool.withdraw({
      ...opts.proof,
      recipient: opts.recipient,
      fee: opts.fee ?? 0n,
      relayer: opts.relayer ?? opts.recipient,
      signer,
    });
    if (opts.noteCommitment) await this.ctx.notes.markSpent(opts.noteCommitment);
    return txHash;
  }

  /**
   * Whether a withdrawal's nullifier is already spent on-chain. Cheap read used
   * to determine, after an ambiguous submission failure, whether the withdrawal
   * actually landed (`true`) or is safe to retry (`false`).
   */
  async isNullifierSpent(opts: {
    nullifierHash: Uint8Array;
    source?: string;
  }): Promise<boolean> {
    return this.ctx.contracts.privacyPool.isNullifierSpent({
      source: await this.source(opts.source),
      nullifierHash: opts.nullifierHash,
    });
  }

  /**
   * Reconcile a note's local spent-state with on-chain nullifier state after an
   * ambiguous withdrawal failure. Marks the note spent iff its nullifier is spent
   * on-chain; otherwise leaves it untouched (safe to retry). Retry-safe and
   * idempotent — it never burns a note whose withdrawal did not land, and never
   * triggers a payout. Returns whether the note is (now) considered spent.
   */
  async reconcileWithdrawal(opts: {
    proof: WithdrawProofBundle;
    noteCommitment: string;
    source?: string;
  }): Promise<{ spent: boolean }> {
    const spent = await this.isNullifierSpent({
      nullifierHash: opts.proof.nullifierHash,
      source: opts.source,
    });
    if (spent) await this.ctx.notes.markSpent(opts.noteCommitment);
    return { spent };
  }

  /** Read the next deposit leaf index. */
  async getDepositCount(opts?: { source?: string }): Promise<number> {
    return this.ctx.contracts.privacyPool.getDepositCount(await this.source(opts?.source));
  }

  /** Read the latest published state and ASP roots (or null when unpublished). */
  async getRoots(opts?: {
    source?: string;
  }): Promise<{ state: Uint8Array | null; asp: Uint8Array | null }> {
    const source = await this.source(opts?.source);
    const [state, asp] = await Promise.all([
      this.ctx.contracts.privacyPool.getLatestRoot({ source, kind: "state" }),
      this.ctx.contracts.privacyPool.getLatestRoot({ source, kind: "asp" }),
    ]);
    return { state, asp };
  }

  /**
   * Generate a full-withdrawal proof for a note. Requires an artifact resolver
   * (`new OpaqueClient({ artifacts })`). The pool leaves are reconstructed from
   * on-chain Deposit/Withdraw events automatically; pass `stateLeaves` +
   * `depositIndices` to skip the on-chain read (e.g. in tests).
   */
  async proveWithdraw(opts: {
    note: PoolNote;
    recipient: string;
    relayer?: string;
    fee?: bigint;
    scope?: number;
    stateLeaves?: bigint[];
    depositIndices?: number[];
    /** Testing only: inject a stub in place of `snarkjs`. */
    snarkjs?: Parameters<typeof provePoolWithdraw>[0]["snarkjs"];
  }): Promise<PoolWithdrawProof> {
    if (!this.ctx.artifacts) {
      throw new NotWiredError(
        "Pool withdrawal proof generation",
        "Construct OpaqueClient with { artifacts } to enable proving, or pass a precomputed bundle to withdraw().",
      );
    }
    let { stateLeaves, depositIndices } = opts;
    if (!stateLeaves || !depositIndices) {
      const state = await this.ctx.contracts.privacyPool.reconstructState({
        startLedger: this.ctx.config.startLedger,
      });
      stateLeaves = state.stateLeaves;
      depositIndices = state.depositIndices;
    }
    return provePoolWithdraw({
      note: opts.note,
      recipient: opts.recipient,
      relayer: opts.relayer ?? opts.recipient,
      fee: opts.fee ?? 0n,
      scope: opts.scope ?? this.ctx.config.pool.scope,
      stateLeaves,
      depositIndices,
      artifacts: this.ctx.artifacts,
      snarkjs: opts.snarkjs,
    });
  }

  /**
   * Dry-run a full withdrawal for a note: generates the proof and simulates the
   * withdrawal transaction, but never signs or submits it. Lets an integrator
   * validate a withdrawal end-to-end — including the real payout and resource
   * cost — without spending the note's nullifier.
   */
  async dryRunWithdraw(opts: {
    note: PoolNote;
    recipient: string;
    relayer?: string;
    fee?: bigint;
    scope?: number;
    stateLeaves?: bigint[];
    depositIndices?: number[];
    /** Account to simulate the transaction from (defaults to the connected signer). */
    source?: string;
    /** Testing only: inject a stub in place of `snarkjs`. */
    snarkjs?: Parameters<typeof provePoolWithdraw>[0]["snarkjs"];
  }): Promise<DryRunWithdrawResult> {
    const fee = opts.fee ?? 0n;
    const relayer = opts.relayer ?? opts.recipient;
    const source = await this.source(opts.source);

    const proof = await this.proveWithdraw({
      note: opts.note,
      recipient: opts.recipient,
      relayer,
      fee,
      scope: opts.scope,
      stateLeaves: opts.stateLeaves,
      depositIndices: opts.depositIndices,
      snarkjs: opts.snarkjs,
    });

    const simulation = await this.ctx.contracts.privacyPool.simulateWithdraw({
      ...proof,
      recipient: opts.recipient,
      fee,
      relayer,
      source,
    });

    return {
      proof,
      recipient: opts.recipient,
      relayer,
      fee,
      expectedPayout: proof.withdrawnValue - fee,
      simulation,
    };
  }
}

export interface DryRunWithdrawResult {
  proof: PoolWithdrawProof;
  recipient: string;
  relayer: string;
  fee: bigint;
  /** `proof.withdrawnValue - fee`: what `recipient` would actually receive. */
  expectedPayout: bigint;
  /** Simulated fee + resource usage; nothing here was submitted on-chain. */
  simulation: SimulationReport;
}
