import { Link } from "react-router-dom";
import { LegalPageLayout } from "./LegalPageLayout";
import {
  ADVERSARY_SUMMARY,
  PRIVACY_NOT_HIDDEN,
  PRIVACY_PROVIDED,
} from "../lib/privacyThreatModel";

export function ThreatModelPage() {
  return (
    <LegalPageLayout title="Privacy Threat Model">
      <section>
        <h2 className="text-white font-medium text-base mb-2">Purpose and scope</h2>
        <p>
          Opaque combines stealth receiving, browser-side scanning, association-set
          privacy pools, relayed withdrawals, and selective ZK reputation on Stellar.
          This page explains what those mechanisms are intended to protect, what remains
          visible, and which mitigations map to implementation work. For browser key
          storage details, see{" "}
          <a
            href="https://github.com/collinsadi/opaque-stellar/blob/main/docs/GHOST_THREAT_MODEL.md"
            target="_blank"
            rel="noopener noreferrer"
            className="text-white underline hover:text-white"
          >
            Ghost Address Key Storage: Threat Model
          </a>{" "}
          in the repository.
        </p>
      </section>

      <section>
        <h2 className="text-white font-medium text-base mb-2">Security and privacy goals</h2>
        <ul className="list-disc pl-5 space-y-2">
          {PRIVACY_PROVIDED.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </section>

      <section>
        <h2 className="text-white font-medium text-base mb-2">Not protected by this protocol</h2>
        <ul className="list-disc pl-5 space-y-2">
          {PRIVACY_NOT_HIDDEN.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </section>

      <section>
        <h2 className="text-white font-medium text-base mb-2">Primary assets</h2>
        <ul className="list-disc pl-5 space-y-2">
          <li>Recipient linkability between a public wallet and one-time receive accounts.</li>
          <li>Pool withdrawal unlinkability between deposit identity and withdrawal identity.</li>
          <li>Pool note secrecy, ghost private keys, backup passwords, and local transaction records.</li>
          <li>Reputation witness data, undisclosed traits, and nullifier uniqueness.</li>
          <li>Integrity of deployed contract IDs, WASM artifacts, circuit artifacts, and root publishers.</li>
        </ul>
      </section>

      <section>
        <h2 className="text-white font-medium text-base mb-2">Adversaries and observations</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm border-collapse">
            <thead>
              <tr className="border-b border-ink-700 text-mist">
                <th className="py-2 pr-4 font-medium">Adversary</th>
                <th className="py-2 font-medium">Primary risk</th>
              </tr>
            </thead>
            <tbody>
              {ADVERSARY_SUMMARY.map(({ name, risk }) => (
                <tr key={name} className="border-b border-ink-800/80">
                  <td className="py-2 pr-4 text-neutral-200">{name}</td>
                  <td className="py-2 text-mist">{risk}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2 className="text-white font-medium text-base mb-2">Threat categories</h2>
        <div className="space-y-4">
          <div>
            <h3 className="text-neutral-200 font-medium text-sm mb-1">Address linkage</h3>
            <p>
              Funding paths, withdrawal destinations, and wallet registration can link stealth
              activity back to your everyday Stellar identity. Use separate funding and sweep
              destinations where unlinkability matters.
            </p>
          </div>
          <div>
            <h3 className="text-neutral-200 font-medium text-sm mb-1">Timing &amp; amount analysis</h3>
            <p>
              Amounts, fees, and block timestamps remain public. Clustering analysis can correlate
              payments even when receive addresses differ. Privacy-pool deposits and withdrawals
              need sufficient set size, amount discipline, and time separation.
            </p>
          </div>
          <div>
            <h3 className="text-neutral-200 font-medium text-sm mb-1">Wallet signatures and fee payers</h3>
            <p>
              Freighter signs registration, sends, deposits, sweeps, and some reputation actions.
              Those signatures can bind protocol use to your connected G-address. Relayers reduce
              this linkage for pool withdrawal submission, but not for every protocol action.
            </p>
          </div>
          <div>
            <h3 className="text-neutral-200 font-medium text-sm mb-1">RPC &amp; indexer metadata</h3>
            <p>
              Scanning paginates contract events through RPC or Horizon. Your provider may log IP,
              query filters, and session timing. On-device scanning does not conceal infrastructure
              metadata.
            </p>
          </div>
          <div>
            <h3 className="text-neutral-200 font-medium text-sm mb-1">Local storage and backups</h3>
            <p>
              Ghost addresses, pool notes, recovery material, and transaction logs live on your
              device. Cleared storage or lost backups can make funds permanently inaccessible.
              Encrypted storage still fails against XSS at password entry or a compromised browser.
            </p>
          </div>
          <div>
            <h3 className="text-neutral-200 font-medium text-sm mb-1">ASP and relayer trust</h3>
            <p>
              The ASP publishes roots needed for pool withdrawals and the relayer delivers selected
              encrypted withdrawal payloads. Neither service should be able to steal funds or forge
              proofs, but both can affect liveness and may observe timing metadata.
            </p>
          </div>
          <div>
            <h3 className="text-neutral-200 font-medium text-sm mb-1">Proof disclosure and reuse</h3>
            <p>
              Proving a trait reveals the public inputs and fields included in that proof. Repeated
              proofs across apps may correlate the same identity or nullifier scope over time.
            </p>
          </div>
        </div>
      </section>

      <section>
        <h2 className="text-white font-medium text-base mb-2">Trust assumptions</h2>
        <ul className="list-disc pl-5 space-y-2">
          <li>Stellar consensus, Soroban execution, and account signature checks behave correctly.</li>
          <li>Secp256k1 ECDH, AES-256-GCM, PBKDF2-SHA256, Poseidon, Keccak-256, and Groth16 assumptions hold.</li>
          <li>Deployment manifests and artifact hashes match the contracts and circuits users intend to use.</li>
          <li>Browsers, wallet extensions, RPC providers, gateways, and relayers may be honest, faulty, or privacy invasive.</li>
          <li>Users keep local notes, passwords, and backups available and private.</li>
        </ul>
      </section>

      {/*
      <section>
        <h2 className="text-white font-medium text-base mb-2">Mitigations</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs border-collapse">
            <thead>
              <tr className="border-b border-ink-700 text-mist">
                <th className="py-2 pr-3 font-medium">ID</th>
                <th className="py-2 pr-3 font-medium">Threat</th>
                <th className="py-2 pr-3 font-medium">Mitigation</th>
                <th className="py-2 pr-3 font-medium">Issue</th>
                <th className="py-2 font-medium">Implementation</th>
              </tr>
            </thead>
            <tbody>
              {MITIGATIONS.map((m) => (
                <tr key={m.id} className="border-b border-ink-800/80 align-top">
                  <td className="py-2 pr-3 font-mono text-neutral-400">{m.id}</td>
                  <td className="py-2 pr-3 text-neutral-200">{m.threat}</td>
                  <td className="py-2 pr-3">{m.mitigation}</td>
                  <td className="py-2 pr-3 font-mono text-mist">{m.issue ?? "None"}</td>
                  <td className="py-2 font-mono text-mist/80 break-all">{m.implementation}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      */}

      <section>
        <h2 className="text-white font-medium text-base mb-2">Operational guidance</h2>
        <ul className="list-disc pl-5 space-y-2">
          <li>Use self-hosted RPC or trusted RPC when scan metadata matters.</li>
          <li>Wait for larger pool association sets before withdrawing when unlinkability matters.</li>
          <li>Avoid uncommon amounts and immediate deposit-to-withdrawal timing when possible.</li>
          <li>Keep browser extensions minimal and treat local backups as sensitive key material.</li>
          <li>Verify contract addresses and artifact hashes against official deployment manifests.</li>
        </ul>
      </section>

      <section>
        <h2 className="text-white font-medium text-base mb-2">Related policies</h2>
        <p>
          See also{" "}
          <Link to="/privacy" className="text-white underline hover:text-white">
            Privacy Policy
          </Link>
          ,{" "}
          <Link to="/disclaimer" className="text-white underline hover:text-white">
            Disclaimer
          </Link>
          , and the{" "}
          <a
            href="https://github.com/collinsadi/opaque-stellar/blob/main/docs/technical-overview.md"
            target="_blank"
            rel="noopener noreferrer"
            className="text-white underline hover:text-white"
          >
            Technical Overview
          </a>{" "}
          in the repository.
        </p>
      </section>
    </LegalPageLayout>
  );
}
