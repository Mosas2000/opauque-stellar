/**
 * Announcement deduplication tests (#402).
 *
 * Verifies that the composite (tx_hash, event_index) dedup key prevents
 * duplicate entries when the same event is re-fetched or replayed.
 */

import { describe, it, expect } from "vitest";
import {
  announcementId,
  announcementIdFromEventId,
} from "../opaqueCache";

describe("announcementId (legacy key)", () => {
  it("produces a stable key from cluster + txSig + logIndex", () => {
    const key = announcementId("testnet", "abc123", 0);
    expect(key).toBe("testnet-abc123-0");
  });

  it("different logIndex → different key (events within same tx are unique)", () => {
    const a = announcementId("testnet", "abc123", 0);
    const b = announcementId("testnet", "abc123", 1);
    expect(a).not.toBe(b);
  });

  it("different txSig → different key", () => {
    const a = announcementId("testnet", "aaa", 0);
    const b = announcementId("testnet", "bbb", 0);
    expect(a).not.toBe(b);
  });

  it("different cluster → different key", () => {
    const a = announcementId("testnet", "tx1", 0);
    const b = announcementId("mainnet", "tx1", 0);
    expect(a).not.toBe(b);
  });
});

describe("announcementIdFromEventId (Soroban dedup key)", () => {
  it("produces a stable key from cluster + Soroban event ID", () => {
    const key = announcementIdFromEventId("testnet", "0001000000000007b");
    expect(key).toBe("testnet:0001000000000007b");
  });

  it("same eventId → same key (dedup across re-fetches)", () => {
    const eventId = "0001000000000007b";
    const a = announcementIdFromEventId("testnet", eventId);
    const b = announcementIdFromEventId("testnet", eventId);
    expect(a).toBe(b);
  });

  it("different eventId → different key (distinct events are not collapsed)", () => {
    const a = announcementIdFromEventId("testnet", "event-1");
    const b = announcementIdFromEventId("testnet", "event-2");
    expect(a).not.toBe(b);
  });

  it("different cluster → different key even for the same eventId", () => {
    const a = announcementIdFromEventId("testnet", "event-1");
    const b = announcementIdFromEventId("mainnet", "event-1");
    expect(a).not.toBe(b);
  });

  it("key format is distinct from legacy announcementId (no collision)", () => {
    // announcementIdFromEventId uses ':' separator; announcementId uses '-'
    // so a cluster named 'testnet' and txSig 'x' cannot produce the same string.
    const legacy = announcementId("testnet", "x", 0);
    const eventBased = announcementIdFromEventId("testnet", "x-0");
    expect(legacy).not.toBe(eventBased);
  });
});

describe("dedup invariant: re-fetch of same event must yield same record ID", () => {
  it("Soroban eventId is the single source of truth for dedup", () => {
    // Simulate fetching the same event twice (e.g. after RPC retry or minor reorg).
    // Even if ledger number changes due to reorg, the eventId stays constant,
    // so both fetches produce the same IndexedDB record key.
    const eventId = "0000000200000001";

    const firstFetch = announcementIdFromEventId("testnet", eventId);
    const secondFetch = announcementIdFromEventId("testnet", eventId);

    expect(firstFetch).toBe(secondFetch);
  });

  it("two events in the same transaction get different dedup keys", () => {
    // Each event in a Stellar transaction has a unique event ID.
    const keyA = announcementIdFromEventId("testnet", "ledger-tx-event0");
    const keyB = announcementIdFromEventId("testnet", "ledger-tx-event1");
    expect(keyA).not.toBe(keyB);
  });

  it("legacy fallback: events without eventId dedup by txSig+logIndex", () => {
    // When no Soroban eventId is available, fall back to the legacy scheme.
    const key1 = announcementId("testnet", "tx_hash_abc", 0);
    const key2 = announcementId("testnet", "tx_hash_abc", 0);
    expect(key1).toBe(key2);
  });
});
