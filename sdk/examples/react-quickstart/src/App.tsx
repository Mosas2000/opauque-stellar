/**
 * Minimal React example wiring connect → receive → deposit → withdraw →
 * relayer → reputation through @opaquecash/stellar. Runs against Stellar
 * testnet.
 *
 * See README.md for setup (Freighter extension + a funded testnet account).
 *
 * This intentionally mirrors `examples/node-quickstart.mjs`'s scope and
 * honesty about what needs real infra: withdrawal *proof generation* needs
 * circuit artifacts (see `OPAQUE_CIRCUITS_URL` below) and is optional here,
 * exactly like in the Node example.
 */
import { useCallback, useState } from "react";
import {
  isConnected as freighterIsConnected,
  requestAccess,
  getAddress,
  signTransaction as freighterSignTransaction,
  signMessage as freighterSignMessage,
} from "@stellar/freighter-api";
import {
  OpaqueClient,
  callbackSigner,
  type StealthIdentity,
  type ScanMatch,
  type ReputationProof,
} from "@opaquecash/stellar";

/** Fixed message signed once to deterministically derive a stealth identity. */
const IDENTITY_SETUP_MESSAGE = "opaque-cash-react-quickstart-v1";

type ScanProgress =
  | { phase: "idle" }
  | { phase: "deriving-identity" }
  // scanIterator streams matches from an open-ended chain range, so there is
  // no known total up front — progress is reported as "matches found so far
  // as of this ledger", not a checked/total fraction.
  | { phase: "scanning"; matchesFound: number; lastLedger: number }
  | { phase: "done"; matches: ScanMatch[] }
  | { phase: "error"; message: string };

type ProofProgress =
  | { phase: "idle" }
  | { phase: "reconstructing-state" }
  | { phase: "generating-proof" }
  | { phase: "done" }
  | { phase: "unavailable"; reason: string }
  | { phase: "error"; message: string };

function buildFreighterSigner(networkPassphrase: string) {
  return callbackSigner({
    publicKey: async () => {
      const { address } = await getAddress();
      return address;
    },
    signTransaction: async (xdr: string) => {
      const res = await freighterSignTransaction(xdr, { networkPassphrase });
      if (res.error) throw new Error(res.error.message);
      return res.signedTxXdr;
    },
    signMessage: async (message: string) => {
      const res = await freighterSignMessage(message);
      if (res.error) throw new Error(res.error.message);
      if (!res.signedMessage) throw new Error("Freighter returned an empty signature");
      return res.signedMessage.toString();
    },
  });
}

export function App() {
  const [connectedAddress, setConnectedAddress] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [client, setClient] = useState<OpaqueClient | null>(null);

  const [identity, setIdentity] = useState<StealthIdentity | null>(null);
  const [scanProgress, setScanProgress] = useState<ScanProgress>({ phase: "idle" });

  const [depositAmount, setDepositAmount] = useState("10");
  const [depositStatus, setDepositStatus] = useState<string | null>(null);

  const [withdrawRecipient, setWithdrawRecipient] = useState("");
  const [proofProgress, setProofProgress] = useState<ProofProgress>({ phase: "idle" });

  const [relayedRecipient, setRelayedRecipient] = useState("");
  const [relayedProgress, setRelayedProgress] = useState<ProofProgress>({ phase: "idle" });

  const [reputationAttestationId, setReputationAttestationId] = useState("");
  const [reputationStealthPrivKey, setReputationStealthPrivKey] = useState("");
  const [reputationExternalNullifier, setReputationExternalNullifier] = useState("42");
  const [reputationProgress, setReputationProgress] = useState<ProofProgress>({ phase: "idle" });

  // ── 1. Connect ────────────────────────────────────────────────────────────
  const connect = useCallback(async () => {
    setConnectError(null);
    try {
      const installed = await freighterIsConnected();
      if (!installed.isConnected) {
        throw new Error("Freighter extension not detected — install it from freighter.app");
      }
      const access = await requestAccess();
      if (access.error) throw new Error(access.error.message);

      const opaque = new OpaqueClient({
        network: "testnet",
        signer: buildFreighterSigner(
          "Test SDF Network ; September 2015", // testnet passphrase
        ),
      });

      setClient(opaque);
      setConnectedAddress(access.address);
    } catch (err) {
      setConnectError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  // ── 2. Receive: derive identity, then scan announcements with progress ────
  const deriveAndScan = useCallback(async () => {
    if (!client) return;
    setScanProgress({ phase: "deriving-identity" });
    try {
      // A stable signature is all that's needed to derive the viewing/spending
      // keys — no funds move here.
      const signer = client.requireSigner();
      const signature =
        (await signer.signMessage?.(IDENTITY_SETUP_MESSAGE)) ??
        (() => {
          throw new Error("Connected signer does not support signMessage");
        })();
      const derived = client.payments.deriveIdentity(signature);
      setIdentity(derived);

      // Reads announcement pages from the live testnet chain (via
      // stealthAnnouncer.scanEvents) and matches them incrementally, exactly
      // as the production frontend's useScanner.ts does — just without its
      // IndexedDB cache layer. The SDK persists the resumable cursor itself
      // (ctx.scanStore), so a second run only re-scans new ledgers.
      const matches: ScanMatch[] = [];
      for await (const match of client.payments.scanIterator({ identity: derived })) {
        matches.push(match);
        setScanProgress({ phase: "scanning", matchesFound: matches.length, lastLedger: match.ledger });
      }
      setScanProgress({ phase: "done", matches });
    } catch (err) {
      setScanProgress({ phase: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }, [client]);

  // ── 3. Deposit ────────────────────────────────────────────────────────────
  const deposit = useCallback(async () => {
    if (!client) return;
    setDepositStatus("Submitting deposit…");
    try {
      const { note, txHash } = await client.pool.deposit({ amountXlm: depositAmount });
      setDepositStatus(
        `Deposited ${depositAmount} XLM. Note commitment ${note.commitment.slice(0, 10)}… ` +
          `(tx ${txHash.slice(0, 10)}…)`,
      );
    } catch (err) {
      setDepositStatus(`Deposit failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [client, depositAmount]);

  // ── 4. Withdraw (with proof-generation progress) ──────────────────────────
  const withdraw = useCallback(async () => {
    if (!client) return;
    if (!client.artifacts) {
      setProofProgress({
        phase: "unavailable",
        reason:
          "No circuit artifact resolver configured. Construct OpaqueClient with " +
          "{ artifacts } (see OPAQUE_CIRCUITS_DIR in examples/node-quickstart.mjs) " +
          "to enable real proof generation, or wire a precomputed proof bundle.",
      });
      return;
    }

    const notes = await client.notes.list?.();
    const note = notes?.find((n) => !n.spent);
    if (!note) {
      setProofProgress({ phase: "error", message: "No unspent notes available to withdraw." });
      return;
    }

    try {
      setProofProgress({ phase: "reconstructing-state" });
      setProofProgress({ phase: "generating-proof" });
      const proof = await client.pool.proveWithdraw({
        note,
        recipient: withdrawRecipient,
      });
      await client.pool.withdraw({
        proof,
        recipient: withdrawRecipient,
        noteCommitment: note.commitment,
      });
      setProofProgress({ phase: "done" });
    } catch (err) {
      setProofProgress({ phase: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }, [client, withdrawRecipient]);

  // ── 5. Relayed Withdraw (via relayer market) ────────────────────────────
  const relayedWithdraw = useCallback(async () => {
    if (!client) return;
    if (!client.artifacts) {
      setRelayedProgress({
        phase: "unavailable",
        reason:
          "No circuit artifact resolver configured. Construct OpaqueClient with " +
          "{ artifacts } (see OPAQUE_CIRCUITS_DIR in examples/node-quickstart.mjs) " +
          "to enable real proof generation, or wire a precomputed proof bundle.",
      });
      return;
    }

    const notes = await client.notes.list?.();
    const note = notes?.find((n) => !n.spent);
    if (!note) {
      setRelayedProgress({ phase: "error", message: "No unspent notes available to withdraw." });
      return;
    }

    try {
      setRelayedProgress({ phase: "reconstructing-state" });
      setRelayedProgress({ phase: "generating-proof" });

      // Generate proof bound to the registry (relayer must be registry, fee 0)
      const registryId = client.config.contracts.relayerRegistry;
      const proof = await client.pool.proveWithdraw({
        note,
        recipient: relayedRecipient,
        relayer: registryId,
        fee: 0n,
      });

      // Build the blind payload + job draft
      const payload = client.relayer.buildWithdrawPayload({ proof, recipient: relayedRecipient });
      const deadlineLedger = await client.relayer.deadlineLedger();
      const draft = client.relayer.buildJobDraft({
        payload,
        fee: 1_000_000n,
        deadlineLedger,
      });

      // Escrow the job on-chain
      await client.relayer.createJobForDraft(draft);

      // Advertise, collect bids, pick a relayer
      await client.relayer.advertise(draft);
      const bids = await client.relayer.fetchBids(draft.jobIdHex);
      const bid = client.relayer.pickBid(bids);
      if (!bid) {
        setRelayedProgress({ phase: "error", message: "No valid relayer bids yet — retry shortly." });
        return;
      }

      // Deliver the encrypted payload
      await client.relayer.deliverPayload({ draft, bid });

      // Track status
      const status = await client.relayer.jobStatus(draft.jobIdHex);
      if (status === "submitted") {
        await client.notes.markSpent(note.commitment);
      }

      setRelayedProgress({ phase: "done" });
    } catch (err) {
      setRelayedProgress({ phase: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }, [client, relayedRecipient]);

  // ── 6. Reputation Proof ──────────────────────────────────────────────────
  const reputationProve = useCallback(async () => {
    if (!client) return;
    if (!client.artifacts) {
      setReputationProgress({
        phase: "unavailable",
        reason:
          "No circuit artifact resolver configured. Construct OpaqueClient with " +
          "{ artifacts } (see OPAQUE_CIRCUITS_DIR in examples/node-quickstart.mjs) " +
          "to enable real proof generation, or wire a precomputed proof bundle.",
      });
      return;
    }

    try {
      setReputationProgress({ phase: "reconstructing-state" });
      setReputationProgress({ phase: "generating-proof" });

      const proof = await client.reputation.prove({
        attestationId: BigInt(reputationAttestationId),
        stealthPrivKey: Uint8Array.from(Buffer.from(reputationStealthPrivKey, "hex")),
        externalNullifier: BigInt(reputationExternalNullifier),
      });

      await client.reputation.verifyOnChain(proof);
      setReputationProgress({ phase: "done" });
    } catch (err) {
      setReputationProgress({ phase: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }, [client, reputationAttestationId, reputationStealthPrivKey, reputationExternalNullifier]);

  return (
    <main style={{ fontFamily: "monospace", maxWidth: 640, margin: "2rem auto" }}>
      <h1>Opaque Cash — React Quickstart</h1>
      <p>Testnet example wiring connect → receive → deposit → withdraw (#575).</p>

      <section>
        <h2>1. Connect</h2>
        {connectedAddress ? (
          <p>Connected: {connectedAddress}</p>
        ) : (
          <button onClick={connect}>Connect Freighter</button>
        )}
        {connectError && <p style={{ color: "crimson" }}>{connectError}</p>}
      </section>

      <section>
        <h2>2. Receive</h2>
        <button onClick={deriveAndScan} disabled={!client}>
          Derive identity &amp; scan
        </button>
        {identity && <p>Meta-address: {identity.metaHex.slice(0, 22)}…</p>}
        {scanProgress.phase === "deriving-identity" && <p>Deriving identity…</p>}
        {scanProgress.phase === "scanning" && (
          <p>
            Scanning… {scanProgress.matchesFound} match(es) found so far, up to ledger{" "}
            {scanProgress.lastLedger}
          </p>
        )}
        {scanProgress.phase === "done" && <p>Found {scanProgress.matches.length} transfer(s).</p>}
        {scanProgress.phase === "error" && <p style={{ color: "crimson" }}>{scanProgress.message}</p>}
      </section>

      <section>
        <h2>3. Deposit</h2>
        <input
          value={depositAmount}
          onChange={(e) => setDepositAmount(e.target.value)}
          placeholder="Amount (XLM)"
        />
        <button onClick={deposit} disabled={!client}>
          Deposit
        </button>
        {depositStatus && <p>{depositStatus}</p>}
      </section>

      <section>
        <h2>4. Withdraw</h2>
        <input
          value={withdrawRecipient}
          onChange={(e) => setWithdrawRecipient(e.target.value)}
          placeholder="Recipient G-address"
        />
        <button onClick={withdraw} disabled={!client || !withdrawRecipient}>
          Withdraw
        </button>
        {proofProgress.phase === "reconstructing-state" && <p>Reconstructing pool state from chain…</p>}
        {proofProgress.phase === "generating-proof" && <p>Generating zero-knowledge proof… (this can take a while)</p>}
        {proofProgress.phase === "done" && <p>Withdrawal confirmed.</p>}
        {proofProgress.phase === "unavailable" && <p>{proofProgress.reason}</p>}
        {proofProgress.phase === "error" && <p style={{ color: "crimson" }}>{proofProgress.message}</p>}
      </section>

      <section>
        <h2>5. Relayed Withdraw</h2>
        <input
          value={relayedRecipient}
          onChange={(e) => setRelayedRecipient(e.target.value)}
          placeholder="Recipient G-address"
        />
        <button onClick={relayedWithdraw} disabled={!client || !relayedRecipient}>
          Relayed Withdraw
        </button>
        {relayedProgress.phase === "reconstructing-state" && <p>Reconstructing pool state from chain…</p>}
        {relayedProgress.phase === "generating-proof" && <p>Generating zero-knowledge proof… (this can take a while)</p>}
        {relayedProgress.phase === "done" && <p>Relayed withdrawal confirmed.</p>}
        {relayedProgress.phase === "unavailable" && <p>{relayedProgress.reason}</p>}
        {relayedProgress.phase === "error" && <p style={{ color: "crimson" }}>{relayedProgress.message}</p>}
      </section>

      <section>
        <h2>6. Reputation Proof</h2>
        <input
          value={reputationAttestationId}
          onChange={(e) => setReputationAttestationId(e.target.value)}
          placeholder="Attestation ID"
        />
        <input
          value={reputationStealthPrivKey}
          onChange={(e) => setReputationStealthPrivKey(e.target.value)}
          placeholder="Stealth private key (hex)"
        />
        <input
          value={reputationExternalNullifier}
          onChange={(e) => setReputationExternalNullifier(e.target.value)}
          placeholder="External nullifier"
        />
        <button
          onClick={reputationProve}
          disabled={!client || !reputationAttestationId || !reputationStealthPrivKey}
        >
          Prove Reputation
        </button>
        {reputationProgress.phase === "reconstructing-state" && <p>Preparing witness…</p>}
        {reputationProgress.phase === "generating-proof" && <p>Generating zero-knowledge proof… (this can take a while)</p>}
        {reputationProgress.phase === "done" && <p>Reputation proof verified on-chain.</p>}
        {reputationProgress.phase === "unavailable" && <p>{reputationProgress.reason}</p>}
        {reputationProgress.phase === "error" && <p style={{ color: "crimson" }}>{reputationProgress.message}</p>}
      </section>
    </main>
  );
}
