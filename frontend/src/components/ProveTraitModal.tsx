/**
 * ProveTraitModal: Selective disclosure flow for stealth attestations.
 *
 * Shows the user what will be shared (the trait/badge) and what stays hidden
 * (their wallet address, transaction history, stealth addresses). On confirmation,
 * triggers witness generation via WASM and proof generation via snarkjs.
 */

import { useState, useCallback } from "react";
import { debugLog, debugWarn } from "../lib/debugLog";
import { useWallet } from "../hooks/useWallet";
const toHex = (n: bigint | number, opts?: { size?: number }) => {
  const hex = BigInt(n).toString(16);
  const padded = opts?.size ? hex.padStart(opts.size * 2, "0") : hex;
  return `0x${padded}`;
};
import { useReputationStore } from "../store/reputationStore";
import { useOpaqueWasm } from "../hooks/useOpaqueWasm";
import { useKeys } from "../context/KeysContext";
import { getExplorerTxUrl } from "../lib/explorer";
import { fetchLatestValidMerkleRoot, generateReputationProof, submitProofOnChain } from "../lib/reputationProver";
import { isWasmHtmlFallbackError } from "../lib/publicAssets";
import type { DiscoveredTrait, ProofData, ProofStage } from "../lib/reputation";
import { ProofStageTimer } from "../lib/proofDiagnostics";
import { getProofRateLimiter } from "../lib/proofRateLimiter";
import { ModalShell } from "./ModalShell";
import { useCopyToClipboard } from "../hooks/useCopyToClipboard";
import { CopyStatusHint } from "./CopyStatusHint";

type ProveTraitModalProps = {
  trait: DiscoveredTrait;
  onClose: () => void;
};

type ModalStep = "explain" | "generating" | "ready" | "submitting" | "submitted" | "error";

export function ProveTraitModal({ trait, onClose }: ProveTraitModalProps) {
  const { publicKey, signTransaction } = useWallet();
  const [step, setStep] = useState<ModalStep>("explain");
  const [txHash, setTxHash] = useState<string | null>(null);
  const { proofState, startProof, setProofStage, setProofError, setProofReady, resetProof } =
    useReputationStore();
  const { wasm } = useOpaqueWasm();
  const { getMasterKeys, isSetup } = useKeys();

  const handleGenerate = useCallback(async () => {
    if (!wasm) {
      setProofError("WASM module not loaded");
      setStep("error");
      return;
    }
    if (!isSetup) {
      setProofError("Keys not set up. Sign in first.");
      setStep("error");
      return;
    }

    // Acquire rate limiter slot
    const limiter = getProofRateLimiter();
    let releaseSlot: (() => void) | null = null;
    try {
      releaseSlot = limiter.acquireSlot();
    } catch (err) {
      setProofError(err instanceof Error ? err.message : "Proof generation rate limit exceeded");
      setStep("error");
      return;
    }

    setStep("generating");
    startProof(trait.traitDef.id);
    const stageTimer = new ProofStageTimer(trait.traitDef.label);

    try {
      const masterKeys = getMasterKeys();
      const allTraits = useReputationStore.getState().discoveredTraits;
      const attestationsForWasm = allTraits.map((t) => ({
        stealth_address: t.stealthAddress,
        attestation_id: t.attestationId,
        tx_hash: t.txHash,
        block_number: t.blockNumber,
        ephemeral_pubkey: t.ephemeralPubkey ?? [],
      }));

      const externalNullifier = String(Date.now());
      if (!trait.ephemeralPubkey || trait.ephemeralPubkey.length !== 33) {
        throw new Error("Trait is missing ephemeral pubkey. Please rescan announcements and try again.");
      }
      const stealthPrivKey = wasm.reconstruct_signing_key_wasm(
        masterKeys.spendPrivKey,
        masterKeys.viewPrivKey,
        new Uint8Array(trait.ephemeralPubkey)
      );

      const proofData = await generateReputationProof(
        wasm,
        trait,
        JSON.stringify(attestationsForWasm),
        stealthPrivKey,
        externalNullifier,
        (stage, percent) => {
          stageTimer.enter(stage);
          setProofStage(stage as ProofStage, percent);
        },
      );

      // V2 public-signal order: [0] merkle_root. Convert decimal -> bytes32 hex.
      const rawRootSignal = proofData.publicSignals?.[0];
      if (rawRootSignal != null) {
        try {
          const merkleRootBytes32 = toHex(BigInt(rawRootSignal), { size: 32 });
          debugLog("🌲 [Opaque] Merkle root ready", {
            rawSignal: rawRootSignal,
            bytes32Hex: merkleRootBytes32,
          });
        } catch (rootErr) {
          debugWarn("🌲 [Opaque] Failed to convert Merkle root to bytes32", {
            rawSignal: rawRootSignal,
            error: rootErr,
          });
        }
      }

      stageTimer.finish("success");
      setProofReady(proofData);
      setStep("ready");
    } catch (err) {
      stageTimer.finish("error");
      const msg = err instanceof Error ? err.message : "Unknown error during proof generation";
      setProofError(
        isWasmHtmlFallbackError(msg)
          ? "The deployed app is serving HTML instead of the V2 witness WASM. Redeploy with the frontend circuit artifacts present and hash-verified."
          : msg,
      );
      setStep("error");
    } finally {
      if (releaseSlot) releaseSlot();
    }
  }, [wasm, isSetup, trait, getMasterKeys, startProof, setProofStage, setProofError, setProofReady]);

  const handleSubmit = useCallback(async (merkleRootOverride?: string) => {
    const proof = proofState.proof;
    if (!proof) return;

    setStep("submitting");
    setProofStage("submitting", 50);

    try {
      if (!publicKey || !signTransaction) {
        throw new Error("Connect Freighter to submit the proof.");
      }
      // V2 public-signal order: [0] merkle_root, [2] external_nullifier.
      const merkleRoot = merkleRootOverride ?? proofState.proof?.publicSignals?.[0] ?? "0x0";
      const externalNullifier = proofState.proof?.publicSignals?.[2] ?? "0";

      const hash = await submitProofOnChain(proof, merkleRoot, externalNullifier, signTransaction, publicKey);
      setTxHash(hash);
      setProofStage("verified", 100);
      setStep("submitted");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "On-chain submission failed";
      setProofError(msg);
      setStep("error");
    }
  }, [proofState.proof, publicKey, signTransaction, setProofStage, setProofError]);

  const handleRetry = useCallback(async () => {
    // If a proof already exists, retry only the on-chain submission path.
    if (proofState.proof) {
      try {
        if (!publicKey) {
          throw new Error("Connect your wallet to retry proof submission.");
        }
        const latestRoot = await fetchLatestValidMerkleRoot(publicKey);
        const rootHex = `0x${Array.from(latestRoot)
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("")}`;
        await handleSubmit(rootHex);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Retry failed";
        setProofError(msg);
        setStep("error");
      }
      return;
    }
    await handleGenerate();
  }, [proofState.proof, publicKey, handleSubmit, handleGenerate, setProofError]);

  const handleClose = () => {
    resetProof();
    onClose();
  };

  return (
    <ModalShell
      open
      title={
        step === "explain"
          ? "Prove trait"
          : step === "generating"
            ? "Generating proof…"
            : step === "ready"
              ? "Proof ready"
              : step === "submitting"
                ? "Submitting…"
                : step === "submitted"
                  ? "Verified"
                  : "Proof failed"
      }
      description={
        step === "explain"
          ? "Generate a zero-knowledge proof locally, then optionally submit it on-chain."
          : null
      }
      onClose={handleClose}
      closeOnBackdrop={step !== "submitting" && step !== "generating"}
      maxWidthClassName="max-w-md"
    >
      {step === "explain" && (
        <ExplainStep trait={trait} onConfirm={handleGenerate} onCancel={handleClose} />
      )}
      {step === "generating" && (
        <GeneratingStep progress={proofState.progress} stage={proofState.stage} />
      )}
      {step === "ready" && (
        <ReadyStep
          trait={trait}
          nullifier={proofState.proof?.nullifier ?? ""}
          proof={proofState.proof}
          onSubmit={handleSubmit}
          onClose={handleClose}
        />
      )}
      {step === "submitting" && <SubmittingStep />}
      {step === "submitted" && <SubmittedStep txHash={txHash} onClose={handleClose} />}
      {step === "error" && (
        <ErrorStep error={proofState.error} onRetry={handleRetry} onClose={handleClose} />
      )}
    </ModalShell>
  );
}

// =============================================================================
// Step components
// =============================================================================

function ExplainStep({
  trait,
  onConfirm,
  onCancel,
}: {
  trait: DiscoveredTrait;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div>
      <div className="rounded-xl border border-ink-700 bg-ink-950/40 p-4 mb-5">
        <div className="text-sm font-medium text-white mb-3">
          You are proving:
        </div>
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-lg bg-black/25 border border-white/25 flex items-center justify-center text-lg text-white">
            {trait.traitDef.icon === "code" ? "</>" : trait.traitDef.icon === "trending-up" ? "↗" : trait.traitDef.icon === "zap" ? "⚡" : trait.traitDef.icon === "shield" ? "🛡" : "◈"}
          </div>
          <div>
            <div className="font-semibold text-white text-sm">{trait.traitDef.label}</div>
            <div className="text-[11px] text-mist">{trait.traitDef.description}</div>
          </div>
        </div>

        <div className="space-y-2.5">
          <div className="flex items-start gap-2.5">
            <span className="text-white mt-0.5 shrink-0 text-xs">✓</span>
            <div>
              <div className="text-xs font-medium text-white">Shared (public)</div>
              <div className="text-[11px] text-mist">
                That you hold the "{trait.traitDef.label}" attestation for this specific action.
              </div>
            </div>
          </div>
          <div className="flex items-start gap-2.5">
            <span className="text-neutral-400 mt-0.5 shrink-0 text-xs">✗</span>
            <div>
              <div className="text-xs font-medium text-neutral-400">Hidden (private)</div>
              <div className="text-[11px] text-mist">
                Your main wallet address, stealth addresses, transaction history,
                balances, and all other traits.
              </div>
            </div>
          </div>
        </div>
      </div>

      <p className="text-[11px] text-mist/80 mb-4">
        A zero-knowledge proof will be generated locally in your browser. No data leaves your device
        until you explicitly submit the proof on-chain.
      </p>

      <div className="flex gap-3">
        <button
          type="button"
          onClick={onCancel}
          className="flex-1 px-4 py-2.5 rounded-xl text-sm font-medium text-mist border border-ink-600 bg-ink-950/30 hover:border-white/30 hover:text-white transition-colors"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onConfirm}
          className="flex-1 px-4 py-2.5 rounded-xl text-sm font-semibold text-black bg-white border border-white hover:bg-black hover:text-white transition-colors"
        >
          Generate Proof
        </button>
      </div>
    </div>
  );
}

function GeneratingStep({ progress, stage }: { progress: number; stage: string }) {
  return (
    <div className="py-4">
      <p className="text-sm font-medium text-white mb-1 text-center">
        Generating zero-knowledge proof…
      </p>
      <p className="text-[11px] text-mist mb-5 text-center">
        This runs entirely in your browser using WebAssembly.
      </p>
      <StagedProgress stages={PROOF_STAGES} currentStage={stage} progress={progress} />
    </div>
  );
}

function ReadyStep({
  trait,
  nullifier,
  proof,
  onSubmit,
  onClose,
}: {
  trait: DiscoveredTrait;
  nullifier: string;
  proof: ProofData | null;
  onSubmit: () => void;
  onClose: () => void;
}) {
  const nullifierCopy = useCopyToClipboard({ secret: true });
  const proofCopy = useCopyToClipboard({ secret: true });

  const handleCopyNullifier = () => void nullifierCopy.copy(nullifier);
  const handleCopyProof = () => {
    if (!proof) return;
    void proofCopy.copy(JSON.stringify(proof, null, 2));
  };

  return (
    <div className="text-center py-2">
      <div className="w-14 h-14 mx-auto mb-4 rounded-full bg-neutral-400/10 border border-neutral-400/30 flex items-center justify-center">
        <span className="text-2xl text-neutral-300">✓</span>
      </div>
      <h4 className="text-sm font-semibold text-white mb-1">Proof Generated</h4>
      <p className="text-[11px] text-mist mb-4">
        Your "{trait.traitDef.label}" proof is ready. Submit it on-chain to verify
        your reputation without revealing your identity.
      </p>

      <div className="rounded-xl bg-ink-950/40 border border-ink-700 p-3 mb-4 text-left">
        <div className="text-[10px] text-mist/70 mb-1">Nullifier (unique per action)</div>
        <div className="flex items-center gap-2">
          <code className="text-[11px] text-slate-200 font-mono truncate flex-1">
            {nullifier}
          </code>
          <button
            type="button"
            onClick={handleCopyNullifier}
            className="text-[10px] text-mist/70 hover:text-white transition-colors shrink-0"
          >
            {nullifierCopy.status === "copied" ? "Copied!" : "Copy"}
          </button>
        </div>
        <CopyStatusHint
          status={nullifierCopy.status}
          remaining={nullifierCopy.remaining}
          onCancelClear={nullifierCopy.cancelClear}
        />
      </div>

      <div className="rounded-xl bg-ink-950/40 border border-ink-700 p-3 mb-4 text-left">
        <div className="text-[10px] text-mist/70 mb-2">Proof payload</div>
        <button
          type="button"
          onClick={handleCopyProof}
          className="w-full px-3 py-2 rounded-xl text-xs font-medium text-mist border border-ink-600 bg-ink-950/30 hover:border-white/30 hover:text-white transition-colors"
        >
          {proofCopy.status === "copied" ? "Copied proof JSON" : "Copy Proof JSON"}
        </button>
        <CopyStatusHint
          status={proofCopy.status}
          remaining={proofCopy.remaining}
          onCancelClear={proofCopy.cancelClear}
        />
      </div>

      <div className="flex gap-3">
        <button
          type="button"
          onClick={onClose}
          className="flex-1 px-4 py-2.5 rounded-xl text-sm font-medium text-mist border border-ink-600 bg-ink-950/30 hover:border-white/30 hover:text-white transition-colors"
        >
          Close
        </button>
        <button
          type="button"
          onClick={onSubmit}
          className="flex-1 px-4 py-2.5 rounded-xl text-sm font-semibold text-black bg-white border border-white hover:bg-black hover:text-white transition-colors"
        >
          Submit On-Chain
        </button>
      </div>
    </div>
  );
}

function SubmittingStep() {
  return (
    <div className="text-center py-4">
      <div className="w-12 h-12 mx-auto mb-4 border-2 border-ink-600 border-t-white rounded-full animate-spin" aria-hidden />
      <p className="text-sm font-medium text-white mb-1">Submitting to verifier...</p>
      <p className="text-[11px] text-mist">
        Confirm the transaction in your wallet.
      </p>
    </div>
  );
}

function SubmittedStep({ txHash, onClose }: { txHash: string | null; onClose: () => void }) {
  return (
    <div className="text-center py-2">
      <div className="w-14 h-14 mx-auto mb-4 rounded-full bg-neutral-400/10 border border-neutral-400/30 flex items-center justify-center">
        <span className="text-2xl text-neutral-300">✓</span>
      </div>
      <h4 className="text-sm font-semibold text-white mb-1">Verified On-Chain!</h4>
      <p className="text-[11px] text-mist mb-4">
        Your reputation proof has been verified by the smart contract.
      </p>

      {txHash && (
        <div className="rounded-xl bg-ink-950/40 border border-ink-700 p-3 mb-4 text-left">
          <div className="text-[10px] text-mist/70 mb-1">Transaction</div>
          <a
            href={getExplorerTxUrl(txHash)}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[11px] text-white underline decoration-white/40 underline-offset-2 hover:decoration-white font-mono truncate block"
          >
            {txHash.slice(0, 10)}...{txHash.slice(-8)}
          </a>
        </div>
      )}

      <button
        type="button"
        onClick={onClose}
        className="w-full px-4 py-2.5 rounded-xl text-sm font-semibold text-black bg-white border border-white hover:bg-black hover:text-white transition-colors"
      >
        Done
      </button>
    </div>
  );
}

function ErrorStep({
  error,
  onRetry,
  onClose,
}: {
  error: string | null;
  onRetry: () => void;
  onClose: () => void;
}) {
  return (
    <div className="text-center py-4">
      <div className="w-12 h-12 mx-auto mb-4 rounded-full bg-neutral-500/10 border border-neutral-500/30 flex items-center justify-center">
        <span className="text-xl text-neutral-400">!</span>
      </div>
      <h4 className="text-sm font-semibold text-white mb-1">Proof Generation Failed</h4>
      <p className="text-[11px] text-neutral-400/80 mb-4">{error || "An unknown error occurred."}</p>
      <div className="flex gap-3">
        <button
          type="button"
          onClick={onClose}
          className="flex-1 px-4 py-2.5 rounded-xl text-sm font-medium text-mist border border-ink-600 bg-ink-950/30 hover:border-white/30 hover:text-white transition-colors"
        >
          Close
        </button>
        <button
          type="button"
          onClick={onRetry}
          className="flex-1 px-4 py-2.5 rounded-xl text-sm font-semibold text-black bg-white border border-white hover:bg-black hover:text-white transition-colors"
        >
          Retry
        </button>
      </div>
    </div>
  );
}
