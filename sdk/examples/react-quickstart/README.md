# React Quickstart

A minimal React app wiring **connect → receive → deposit → withdraw → relayer → reputation** through
`@opaquecash/stellar` against Stellar **testnet**. Companion to
[`examples/node-quickstart.mjs`](../node-quickstart.mjs) — that one is
offline/scriptable; this one shows the same flow through a real wallet
(Freighter) and a browser UI, including the scan-progress and
proof-generation progress states a real app needs to show a user.

## Setup

1. **Install the [Freighter](https://www.freighter.app/) browser extension**
   and create/import an account.
2. **Switch Freighter to Testnet** (Settings → Network → Test Net).
3. **Fund your testnet account** via
   [Friendbot](https://laboratory.stellar.org/#account-creator?network=test)
   or `curl "https://friendbot.stellar.org/?addr=<YOUR_G_ADDRESS>"`.
4. **Build the SDK first** (the example depends on it via `file:../..`, which
   resolves to the built `dist/` output, not `src/`):
   ```bash
   cd ../..            # sdk/
   npm install
   npm run build
   ```
5. **Install and run the example:**
   ```bash
   cd examples/react-quickstart
   npm install
   npm run dev
   ```
6. Open the printed local URL, click through the six sections in order.

## What each step does

1. **Connect** — requests Freighter access and constructs an `OpaqueClient`
   configured for `network: "testnet"` with a Freighter-backed signer.
2. **Receive** — signs a fixed setup message to deterministically derive a
   stealth identity (`payments.deriveIdentity`), then streams matches from the
   live chain via `payments.scanIterator`, updating the UI with matches-found
   and last-scanned-ledger as pages arrive. `scanIterator` persists its
   resumable cursor itself, so clicking it again only scans new ledgers.
3. **Deposit** — calls `pool.deposit({ amountXlm })`, which submits real XLM
   from your connected account into the privacy pool contract and persists
   the resulting note locally.
4. **Withdraw** — calls `pool.proveWithdraw` (zero-knowledge proof
   generation) followed by `pool.withdraw`. **Proof generation requires
   circuit artifacts**, which this example does not bundle (they're large).
   Construct the client with `{ artifacts: fileArtifactResolver({ baseDir })
   }` — see `OPAQUE_CIRCUITS_DIR` in `../node-quickstart.mjs` for the same
   gate — to enable this step for real; otherwise the UI reports it's
   unavailable rather than silently failing, exactly like the Node example.
5. **Relayed Withdraw** — demonstrates the [Relayer Market](/integrate/relayer-market)
   flow: generates a withdrawal proof bound to the registry contract, builds a
   blind payload, escrows the job on-chain, and delivers to a staked relayer.
6. **Reputation Proof** — demonstrates the [ZK Reputation](/integrate/reputation)
   flow: generates a V2 reputation proof and verifies it on-chain.

## Notes

- This example intentionally keeps proof generation optional, matching
  `node-quickstart.mjs`'s own scope — bundling circuit artifacts into a
  "minimal" quickstart would defeat the point of it being minimal.
- `npm run build` here runs a `tsc -b --noEmit` typecheck before the Vite
  build, and is wired into the SDK's own `build` script (see
  `sdk/package.json`) so a breaking SDK API change fails the build here
  instead of silently rotting.
