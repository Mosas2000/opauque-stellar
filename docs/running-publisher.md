# Running The Publisher

The reputation publisher collects V2 reputation leaf commitments submitted by holders, publishes PSR Merkle roots to the reputation verifier contract, and returns Merkle paths for proof generation. The publisher holds a signing key and serves the reputation pipeline.

For the MVP demo, a publisher is already running on testnet. Run your own publisher when testing operator flows, custom policy, or production-style infrastructure.

## What The Publisher Does

| Function                | Purpose                                                                  |
| ----------------------- | ------------------------------------------------------------------------ |
| Accept leaf submissions | Holders submit reputation commitments via HTTP POST                      |
| Build Merkle tree       | Accumulates submitted leaves into a Poseidon Merkle tree                 |
| Publish roots           | Posts the current tree root to the reputation verifier contract on-chain |
| Serve Merkle paths      | Returns authentication paths for proof generation                        |

The publisher cannot move user funds or access private keys. It only publishes roots and serves paths.

## Requirements

| Requirement                | Notes                                                               |
| -------------------------- | ------------------------------------------------------------------- |
| Node.js 20+                | Required for TypeScript tooling.                                    |
| Repository checkout        | The publisher reads deployments/v1/testnet.json from the repo.      |
| Funded publisher authority | Must be able to call update_merkle_root on the reputation verifier. |
| Soroban RPC URL            | Defaults to the testnet RPC unless overridden.                      |

## Install

```bash
git clone https://github.com/collinsadi/opaque-stellar.git
cd opaque-stellar/publisher
npm ci
```

## Configure

Create an environment file outside git:

```bash
nano ~/.opaque-publisher.env
chmod 600 ~/.opaque-publisher.env
```

Example:

```bash
PUBLISHER_SECRET=S...your_publisher_authority_secret...
STELLAR_RPC_URL=https://soroban-testnet.stellar.org
PUBLISHER_HTTP_HOST=127.0.0.1
PUBLISHER_HTTP_PORT=8790
PUBLISHER_CORS_ORIGIN=http://localhost:5173
PUBLISHER_DATA_DIR=/var/lib/opaque-publisher
PUBLISHER_MAX_INBOX=10000
PUBLISHER_INTERVAL_MS=30000
REPUTATION_VERIFIER_ID=C...
```

### Environment Variables

| Variable                | Required | Default                                  | Purpose                                                        |
| ----------------------- | -------- | ---------------------------------------- | -------------------------------------------------------------- |
| PUBLISHER_SECRET        | Yes      | None                                     | Stellar secret seed (S...) for the publisher authority account |
| STELLAR_RPC_URL         | No       | Manifest rpcUrl                          | Soroban RPC endpoint                                           |
| PUBLISHER_HTTP_HOST     | No       | 127.0.0.1                                | HTTP API bind address                                          |
| PUBLISHER_HTTP_PORT     | No       | 8790                                     | HTTP API bind port                                             |
| PUBLISHER_CORS_ORIGIN   | No       | \*                                       | Browser CORS origin for frontend                               |
| PUBLISHER_DATA_DIR      | No       | ./data                                   | Directory for persistent state                                 |
| PUBLISHER_MAX_INBOX     | No       | 5000                                     | Maximum pending leaves before backpressure                     |
| PUBLISHER_INTERVAL_MS   | No       | 15000                                    | Milliseconds between publish cycles                            |
| REPUTATION_VERIFIER_ID  | No       | Manifest contracts.reputationVerifier.id | Contract ID for reputation verifier                            |
| RATE_LIMIT_WINDOW_MS    | No       | 60000                                    | Rate limiting window (milliseconds)                            |
| RATE_LIMIT_MAX_REQUESTS | No       | 120                                      | Maximum requests per window                                    |
| RATE_LIMIT_BURST        | No       | 20                                       | Burst allowance above steady rate                              |

PUBLISHER_SECRET must be able to call update_merkle_root for the deployed reputation verifier.

## Run One Publish Cycle

```bash
cd ~/stellar/publisher
set -a
source ~/.opaque-publisher.env
set +a
npm run publisher:once
```

Healthy output looks like:

```text
inbox=3 (+2) root=0x1a2b3c... PUBLISHED
```

If there is no new work, it should print `in-sync`.

## Run Continuously

```bash
cd ~/stellar/publisher
set -a
source ~/.opaque-publisher.env
set +a
npm run serve
```

The default loop interval is 15 seconds. The HTTP API binds to PUBLISHER_HTTP_HOST:PUBLISHER_HTTP_PORT.

## HTTP API Endpoints

| Endpoint                      | Method | Purpose                             |
| ----------------------------- | ------ | ----------------------------------- |
| POST /v1/reputation/leaves    | POST   | Submit a reputation leaf commitment |
| GET /v1/reputation/root       | GET    | Get the current published root      |
| GET /v1/reputation/path/:leaf | GET    | Get Merkle path for a specific leaf |
| GET /health                   | GET    | Health check (200 OK)               |

### Submit Leaf

```bash
curl -X POST https://publisher.example.com/v1/reputation/leaves \
  -H "Content-Type: application/json" \
  -d '{"leaf": "0x1a2b3c...", "holder": "G..."}'
```

Response:

```json
{
  "status": "queued",
  "leaf": "0x1a2b3c...",
  "index": 42
}
```

### Get Current Root

```bash
curl https://publisher.example.com/v1/reputation/root
```

Response:

```json
{
  "root": "0x1a2b3c...",
  "timestamp": 1234567890,
  "leafCount": 42
}
```

### Get Merkle Path

```bash
curl https://publisher.example.com/v1/reputation/path/0x1a2b3c...
```

Response:

```json
{
  "leaf": "0x1a2b3c...",
  "pathElements": ["0x...", "0x..."],
  "pathIndices": [0, 1],
  "root": "0x1a2b3c..."
}
```

## systemd Service

```ini
[Unit]
Description=Opaque Stellar reputation publisher
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=YOUR_LINUX_USER
WorkingDirectory=/home/YOUR_LINUX_USER/stellar/publisher
EnvironmentFile=/home/YOUR_LINUX_USER/.opaque-publisher.env
ExecStart=/usr/bin/npm run serve
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

Start it:

```bash
sudo systemctl daemon-reload
sudo systemctl enable opaque-publisher
sudo systemctl start opaque-publisher
sudo journalctl -u opaque-publisher -f
```

## Monitoring

Monitor these metrics for operational health:

| Metric            | Source                            | Healthy Range | Alert Threshold    |
| ----------------- | --------------------------------- | ------------- | ------------------ |
| Publish latency   | Logs (time between cycles)        | < 30s         | > 60s              |
| Inbox size        | GET /v1/reputation/root leafCount | < MAX_INBOX/2 | > MAX_INBOX \* 0.8 |
| Root freshness    | On-chain ledger age               | < 5 min       | > 15 min           |
| HTTP availability | GET /health                       | 200 OK        | Non-200 or timeout |
| RPC connection    | Logs                              | Connected     | Connection errors  |

## Troubleshooting

| Symptom                            | Likely cause                                                           | Fix                                                                         |
| ---------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `Set PUBLISHER_SECRET`             | Missing authority secret.                                              | Export PUBLISHER_SECRET or set it in the environment file.                  |
| `update_merkle_root not confirmed` | RPC lag, fee issue, or transaction timeout.                            | Let the loop retry. If repeated, check authority funding and RPC health.    |
| Frontend says root unavailable     | Publisher has not published yet or frontend is reading wrong manifest. | Wait for publish cycle, check manifest alignment.                           |
| `inbox full`                       | More leaves submitted than can be processed.                           | Increase PUBLISHER_MAX_INBOX or reduce submission rate.                     |
| Very slow publish cycles           | Network congestion or underfunded authority.                           | Check RPC health, increase fee budget, or top up authority account.         |
| CORS errors in browser             | PUBLISHER_CORS_ORIGIN mismatch.                                        | Set to match frontend origin exactly.                                       |
| Rate limit errors                  | Too many requests from one source.                                     | Adjust RATE_LIMIT_MAX_REQUESTS or implement client-side retry with backoff. |

## Security Notes

Treat PUBLISHER_SECRET as a hot admin key. Store it with chmod 600, run under a dedicated Linux user, and never commit it.

The publisher cannot spend user funds or access private keys, but it controls what reputation claims can be proven on-chain. For production:

- Use a dedicated key separate from deployer or pool admin
- Run in an isolated environment with minimal attack surface
- Monitor for unexpected leaf submission patterns
- Log all publish operations for audit trail
- Implement backup and recovery procedures for PUBLISHER_DATA_DIR

## Backup and Recovery

The publisher state is stored in PUBLISHER_DATA_DIR. Back up this directory regularly:

```bash
rsync -av /var/lib/opaque-publisher/ backup-server:/backups/publisher/$(date +%Y%m%d)/
```

To restore:

```bash
rsync -av backup-server:/backups/publisher/20240101/ /var/lib/opaque-publisher/
```

## Key Rotation

When rotating the publisher authority key, follow the key rotation runbook:

1. Generate new key
2. Fund new key
3. Update contract to accept new publisher
4. Update PUBLISHER_SECRET in environment
5. Restart publisher service
6. Verify publish cycle succeeds
7. Revoke old key from contract

See docs/publisher-key-rotation-runbook.md for detailed procedures.

## State Backups

Publisher state includes:

- Pending leaf inbox
- Published Merkle tree
- Root history

Back up PUBLISHER_DATA_DIR according to docs/state-backups.md retention policy.

## Related Documentation

- docs/publisher-key-rotation-runbook.md: Key rotation procedures
- docs/state-backups.md: Backup retention policy
- docs/running-asp.md: ASP indexer runbook (separate service)
- docs/running-relayer.md: Relayer operator guide (separate service)
- .env.example: Root environment variable reference
