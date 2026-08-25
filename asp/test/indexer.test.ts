import { describe, expect, it } from "vitest";
import { createPublicationMonitor, createReorgGuard, tick } from "../scripts/indexer.ts";
import { MemoryStore } from "../src/store.ts";
import type { ChainAdapter, Deposit } from "../src/types.ts";

// In-memory chain adapter mirroring the one used for engine tests, so these tests exercise
// the real `indexer.ts` entrypoint wiring rather than the PublicationMonitor/ReorgGuard
// classes in isolation.
class FakeAdapter implements ChainAdapter {
  deposits: Deposit[] = [];
  root: string | null = null;
  posts: Array<{ root: string; datasetHash: string }> = [];

  async readDeposits(afterIndex: number): Promise<Deposit[]> {
    return this.deposits.filter((d) => d.index > afterIndex);
  }
  async currentAspRoot() {
    return this.root;
  }
  async postAspRoot(root: string, datasetHash: string) {
    this.root = root;
    this.posts.push({ root, datasetHash });
  }
  async latestLedger() {
    return 1000;
  }
}

function deposit(index: number, ledger: number): Deposit {
  return { index, commitment: `0x${index}`, value: "1000", scope: 1, ledger };
}

function baseCfg(overrides: Partial<{ maxRootAgeMs: number }> = {}) {
  return {
    poolId: "pool",
    scope: 1,
    dataDir: undefined,
    confirmations: 0,
    maxRootAgeMs: overrides.maxRootAgeMs ?? 1000,
  };
}

describe("indexer entrypoint wiring", () => {
  it("threads the PublicationMonitor into runPoolTick and fires a stale-root alert", async () => {
    // Start the fake clock at a non-zero value: PublicationMonitor treats `lastPublishedAt
    // === 0` as its "nothing published yet" sentinel.
    let now = 1000;
    const alerts: string[] = [];
    const monitor = createPublicationMonitor(
      { maxRootAgeMs: 500 },
      { now: () => now, onAlert: (alert: { message: string }) => alerts.push(alert.message) },
    );
    const guard = createReorgGuard();

    const adapter = new FakeAdapter();
    const store = new MemoryStore();
    adapter.deposits = [deposit(0, 10)];

    const cfg = baseCfg({ maxRootAgeMs: 500 });
    const r1 = await tick(cfg, adapter, store, monitor, guard);
    expect(r1.published).toBe(true);
    expect(alerts).toHaveLength(0);

    // Advance the clock past the threshold with no new deposits; the next tick should
    // detect the stale root via the monitor wired through the real indexer `tick()`.
    now += 1000;
    const r2 = await tick(cfg, adapter, store, monitor, guard);
    expect(r2.published).toBe(false);
    expect(r2.staleAlert).not.toBeNull();
    expect(alerts.length).toBeGreaterThan(0);
    expect(alerts[0]).toMatch(/stale|old/i);
  });

  it("threads the ReorgGuard into runPoolTick and halts publication on a ledger rollback", async () => {
    const divergences: string[] = [];
    const monitor = createPublicationMonitor({ maxRootAgeMs: 60_000 });
    const guard = createReorgGuard({
      onDivergence: (event: { message: string }) => divergences.push(event.message),
    });

    const adapter = new FakeAdapter();
    const store = new MemoryStore();
    const cfg = baseCfg();

    adapter.deposits = [deposit(0, 100)];
    const r1 = await tick(cfg, adapter, store, monitor, guard);
    expect(r1.published).toBe(true);
    expect(r1.haltedForReorg).toBe(false);

    // A batch that starts before the previously committed ledger is a rollback.
    adapter.deposits = [deposit(1, 50)];
    const r2 = await tick(cfg, adapter, store, monitor, guard);
    expect(r2.haltedForReorg).toBe(true);
    expect(r2.published).toBe(false);
    expect(divergences.length).toBeGreaterThan(0);
    expect(adapter.posts.length).toBe(1); // no republish while halted
  });
});
