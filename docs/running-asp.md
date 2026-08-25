# Running The ASP

The Association Set Provider keeps the privacy pool withdrawable by publishing roots. It reads public pool events, applies a policy, rebuilds Merkle trees, and posts roots to Soroban.

For the MVP demo, an ASP is already running on testnet and approving all deposits. Run your own ASP when testing operator flows, custom policy, or production-style infrastructure.

## What The ASP Publishes

| Root | Source | Purpose |
| --- | --- | --- |
| ASP root | Approved deposit labels after policy screening. | Lets a withdrawer prove their deposit is in the approved association set. |
| State root | Public deposit commitments and withdrawal remainder commitments. | Lets a withdrawer prove membership in the current pool state. |

The ASP cannot move user funds. It only publishes roots. The privacy-pool contract still verifies proofs, nullifiers, and custody.

## Requirements

| Requirement | Notes |
| --- | --- |
| Node.js 20+ | Required for TypeScript tooling. |
| Repository checkout | The ASP reads `deployments/v1/testnet.json` from the repo. |
| Funded ASP authority | The demo uses the pool admin key to publish roots. |
| Soroban RPC URL | Defaults to the testnet RPC unless overridden. |

## Install

```bash
git clone https://github.com/collinsadi/opaque-stellar.git
cd opaque-stellar/asp
npm ci
```

## Configure

Create an environment file outside git:

```bash
nano ~/.opaque-asp.env
chmod 600 ~/.opaque-asp.env
```

Example:

```bash
ASP_SECRET=S...your_asp_authority_secret...
STELLAR_RPC_URL=https://soroban-testnet.stellar.org
ASP_INTERVAL_MS=15000
ASP_CONFIRMATIONS=1
```

`ASP_SECRET` must be able to call `update_asp_root` and `update_state_root` for the deployed privacy pool.

## Run One Tick

```bash
cd ~/stellar/asp
set -a
source ~/.opaque-asp.env
set +a
npm run indexer:once
```

Healthy output looks like:

```text
approved=8 (+1) asp=0x1724c7a6e034... stateLeaves=11 ASP_PUBLISHED STATE_PUBLISHED
```

If there is no new work, it should print `in-sync`.

## Run Continuously

```bash
cd ~/stellar/asp
set -a
source ~/.opaque-asp.env
set +a
npm run indexer
```

The default loop interval is 15 seconds.

## systemd Service

```ini
[Unit]
Description=Opaque Stellar ASP indexer
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=YOUR_LINUX_USER
WorkingDirectory=/home/YOUR_LINUX_USER/stellar/asp
EnvironmentFile=/home/YOUR_LINUX_USER/.opaque-asp.env
ExecStart=/usr/bin/npm run indexer
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

Start it:

```bash
sudo systemctl daemon-reload
sudo systemctl enable opaque-asp
sudo systemctl start opaque-asp
sudo journalctl -u opaque-asp -f
```

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `Set ASP_SECRET` | Missing authority secret. | Export `ASP_SECRET` or set it in the environment file. |
| `update_asp_root not confirmed` | RPC lag, fee issue, or transaction timeout. | Let the loop retry. If repeated, check authority funding and RPC health. |
| Frontend says roots do not cover deposit | The ASP has not published a root including that deposit yet. | Wait for a tick with `ASP_PUBLISHED STATE_PUBLISHED`, then retry withdrawal. |
| `in-sync` but frontend still fails | Frontend may be reading a different manifest, RPC, or pool deployment. | Compare `deployments/v1/testnet.json`, frontend env, and ASP logs. |
| Very slow catch-up | Fresh ASP state is rebuilding from chain events. | Let it complete or copy `asp/data/` from a trusted running instance. |

## Security Notes

Treat `ASP_SECRET` as a hot admin key. Store it with `chmod 600`, run under a dedicated Linux user, and never commit it. For production, replace approve-all with a documented policy and operational review process.
