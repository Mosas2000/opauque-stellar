# Testnet service SLOs

Service level objectives for the three off-chain testnet services: the ASP indexer,
the relayer market, and the reputation publisher. Without stated objectives there is
no basis for judging whether testnet operations are healthy — this document defines
what "healthy" means for each service, where the numbers come from, and how they're
measured on an ongoing basis.

Objective numbers here are the canonical definitions; [`scripts/slo-report.ts`](../scripts/slo-report.ts)'s
`OBJECTIVES` constant mirrors them exactly. If you change one, change the other in the
same PR.

These are **testnet** objectives — generous enough to tolerate public-RPC flakiness and
demo-scale (not production-scale) traffic, while still being tight enough to catch a
genuinely stuck service. They are not mainnet SLAs.

## Summary

| Service | Latency objective | Availability objective | Measurement source |
|:--|:--|:--|:--|
| ASP publication | p95 publish lag ≤ **2 minutes** | ≥ **99%** of samples within objective | Soroban RPC `getEvents` on `privacyPool` (`Deposit`, `AspRootPublished`, `StateRootPublished`) |
| Relayer completion | p95 completion lag ≤ **5 minutes** | ≥ **95%** job completion rate | Soroban RPC `getEvents` on `relayerRegistry` (`JobCreated`, `JobSubmitted`, `JobSlashed`) |
| Publisher latency | p95 inbox backlog age ≤ **5 minutes** | ≥ **99%** of samples within objective | Publisher's local data directory (inbox backlog) + optional `/health` probe |

## How measurement works

`npm run slo:report` is the periodic report:

1. It takes **one live sample per service** from the measurement source above.
2. It appends that sample to `ops/slo/<service>.jsonl` (gitignored — this is
   accumulated operational data, not a repo artifact).
3. It recomputes p95 latency and availability from the samples accumulated in the
   trailing window (`--window`, default `24h`) and prints PASS/FAIL against the
   objectives.

A single run only tells you about that instant. **Run it periodically** (cron,
systemd timer, CI schedule) so the accumulated sample history is what actually
answers "were we within objective over the last week" — one invocation cannot compute
a p95 or a trailing-week availability figure by itself. Example hourly cron:

```bash
0 * * * * cd /path/to/opaque-stellar && npx tsx scripts/slo-report.ts >> ops/slo/report.log 2>&1
```

```bash
# Ad-hoc run against testnet, default 24h window:
npm run slo:report

# Wider window once you have more history, machine-readable output:
npm run slo:report -- --window 7d --json

# Include the publisher's HTTP availability signal:
npm run slo:report -- --publisher-url http://127.0.0.1:8790
```

### Why "lag", not literal event-to-event latency

Each service's live sample measures **backlog lag**, not a specific event's
end-to-end latency: it compares the most recent "triggering" event (a deposit, a job
creation, a queued leaf) against the most recent "completed" event (a root publish, a
job submission). If the completed stream is caught up, lag is 0. If not, lag is how
long the oldest known outstanding item has been waiting.

This is deliberate: correlating a *specific* deposit to the *specific* root publish
that included it requires decoding and joining on-chain data the ASP already
maintains internally, which would duplicate the ASP's own reconciliation logic in a
read-only reporting tool. Backlog lag is the standard replication/consumer-lag style
proxy for the same thing, is far simpler to compute from event timestamps alone, and
answers the operationally important question ("are we currently behind, and by how
much") just as well.

### On "no activity" samples

On a quiet testnet, a sample can find zero triggering events in its lookback window
(no deposits, no jobs created). Lag is then trivially 0 — technically correct (there
is no backlog), but it isn't evidence the pipeline works under load. The report
prints the observed activity counts (`This run: N Deposit / M root-publish events…`)
and a caveat when the count is zero specifically so this isn't misread as a confirmed
pass. Availability/latency figures are still computed the same way; read them together
with the activity counts, not in isolation.

## Per-service detail

### ASP publication

The Association Set Provider ticks on `ASP_INTERVAL_MS` (default 15s — see
[`docs/running-asp.md`](running-asp.md)) and, on a mismatch, publishes an updated
`aspRoot`/`stateRoot` to the `privacy-pool` contract. Under normal operation with the
default interval and 1 confirmation, a deposit should be reflected within roughly
15-30 seconds; the 2-minute objective gives headroom for RPC retries and occasional
`getEvents` pagination lag without masking a genuinely stuck indexer.

- **Latency objective:** p95 backlog lag between the latest `Deposit` event and the
  latest `AspRootPublished`/`StateRootPublished` event ≤ 2 minutes.
- **Availability objective:** ≥ 99% of samples (trailing window) within the latency
  objective.
- **Measurement source:** Soroban RPC `getEvents` against `deployments/v1/<network>.json`
  → `contracts.privacyPool.id`, topics `Deposit`, `AspRootPublished`, `StateRootPublished`.
  No access to the ASP process itself is required — this is a fully external,
  on-chain measurement.

### Relayer completion

A relayer job goes `JobCreated` → `JobAccepted` → `JobSubmitted` (or `JobSlashed` if
the accepting relayer misses its deadline). "Completion" here means reaching
`JobSubmitted`.

- **Latency objective:** p95 backlog lag between the latest `JobCreated` event and the
  latest `JobSubmitted` event ≤ 5 minutes.
- **Availability objective:** ≥ 95% job completion rate (`JobSubmitted` count ÷
  `JobCreated` count) over the trailing window.
- **Measurement source:** Soroban RPC `getEvents` against
  `contracts.relayerRegistry.id`, topics `JobCreated`, `JobSubmitted`, `JobSlashed`.
  External, on-chain measurement — no access to the relayer process required.

### Publisher latency

The reputation publisher accepts holder-submitted leaf commitments off-chain (see
[`publisher/README.md`](../publisher/README.md) for why that input can't come from
public events) into a local inbox, then publishes an updated Merkle root to the
`reputation-verifier` contract once the inbox differs from the last published root.
Because submission is off-chain by design, there is no on-chain event marking when a
leaf arrived — the local inbox timestamp is the only source of truth for "when did
this show up."

- **Latency objective:** p95 age of the oldest leaf still sitting in the local inbox
  (not yet archived after a successful publish) ≤ 5 minutes.
- **Availability objective:** ≥ 99% of samples (trailing window) within the latency
  objective.
- **Measurement source:** the publisher's local data directory
  (`PUBLISHER_DATA_DIR`, default `publisher/data/inbox/`) — the report must run
  co-located with, or on a volume shared with, the running publisher instance.
  Optionally also probes `<publisher-url>/health` (`--publisher-url` /
  `SLO_PUBLISHER_URL`) for a direct reachability signal; this is skipped, not failed,
  when no URL is configured.

## Limitations

- Soroban RPC event retention is bounded (commonly a matter of days on public
  providers), and each run's live query is further bounded by `--lookback-ledgers`
  (default ~4000 ledgers, ~5.5h) to keep a single run fast. Trailing-window stats
  beyond that come from the accumulated local sample log, not from replaying the
  full window on every run — see "How measurement works" above.
- These objectives assume the demo-scale traffic this repo currently sees. If testnet
  usage grows, revisit the thresholds rather than assuming they still reflect
  operational reality.
