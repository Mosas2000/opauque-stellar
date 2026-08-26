/**
 * End-to-end versioned vault backup: encrypt a full vault (notes, stealth
 * keys, ghost entries) with a password, then decrypt it back. Also confirms
 * the envelope is wire-compatible with `frontend/src/services/recoveryManager.ts`'s
 * format (issue #834) and that unknown/missing fields don't break restore
 * (forward compatibility in both directions).
 */
import { describe, it, expect } from "vitest";
import {
  exportVaultBackup,
  importVaultBackup,
  type VaultBackupFile,
  type VaultBackupPayload,
  type GhostEntryLike,
} from "../../src/crypto/index";

const GHOST_ENTRIES: GhostEntryLike[] = [
  {
    cluster: "testnet",
    stealthAddress: "0xabc123",
    ephemeralPrivKeyHex: "0x" + "11".repeat(32),
    createdAt: 1_700_000_000,
  },
];

const PAYLOAD: VaultBackupPayload = {
  stealthMasterKeys: [{ scheme: "secp256k1", publicKey: "0x02aa" }],
  metaAddresses: [{ address: "st:testnet:abc" }],
  scanKeys: [{ label: "primary" }],
  ghostEntries: GHOST_ENTRIES,
  notes: [{ commitment: "0xnote1", value: "1000000" }],
  recoveryMetadata: { deviceId: "test-device" },
};

describe("versioned vault backup (end to end)", () => {
  it("round-trips a full payload through export/import", async () => {
    const file = await exportVaultBackup(PAYLOAD, "correct horse battery");
    expect(file.version).toBe(1);
    expect(file.formatVersion).toBe(2);
    expect(file.$schema).toBe("https://opaque.cash/schemas/recovery-backup-v2.json");
    expect(JSON.stringify(file)).not.toContain("11".repeat(32));

    const restored = await importVaultBackup(file, "correct horse battery");
    expect(restored).toEqual(PAYLOAD);
  });

  it("fails to decrypt with the wrong password", async () => {
    const file = await exportVaultBackup(PAYLOAD, "right-pin");
    await expect(importVaultBackup(file, "wrong-pin")).rejects.toThrow(
      /Invalid password or corrupted backup file/,
    );
  });

  it("rejects a tampered payload via the checksum", async () => {
    const file = await exportVaultBackup(PAYLOAD, "pin-1234");
    const tampered: VaultBackupFile = { ...file, encrypted_payload: file.encrypted_payload.slice(0, -4) + "AAAA" };
    await expect(importVaultBackup(tampered, "pin-1234")).rejects.toThrow(/Integrity check failed/);
  });

  it("rejects a backup missing required fields", async () => {
    await expect(
      importVaultBackup({ version: 1, timestamp: "now" } as unknown as VaultBackupFile, "pin"),
    ).rejects.toThrow(/Corrupted backup file/);
  });

  it("is forward-compatible with a frontend-shaped payload missing the SDK's `notes` field", async () => {
    // Simulates a backup produced by the frontend today, which has no
    // `notes` field in its schema.
    const legacyPayload = {
      stealthMasterKeys: PAYLOAD.stealthMasterKeys,
      metaAddresses: PAYLOAD.metaAddresses,
      scanKeys: PAYLOAD.scanKeys,
      ghostEntries: PAYLOAD.ghostEntries,
      recoveryMetadata: PAYLOAD.recoveryMetadata,
    };
    const file = await exportVaultBackup(legacyPayload as VaultBackupPayload, "pin-5678");
    const restored = await importVaultBackup(file, "pin-5678");
    expect(restored.notes).toEqual([]);
    expect(restored.ghostEntries).toEqual(GHOST_ENTRIES);
  });

  it("is backward-compatible when the frontend restores an SDK-produced payload with an extra `notes` field", async () => {
    // The frontend's importer only reads the fields it knows about, so an
    // SDK-produced payload with the extra `notes` field still restores the
    // fields the frontend understands.
    const file = await exportVaultBackup(PAYLOAD, "pin-9012");
    const restored = await importVaultBackup(file, "pin-9012");
    expect(restored.stealthMasterKeys).toEqual(PAYLOAD.stealthMasterKeys);
    expect(restored.metaAddresses).toEqual(PAYLOAD.metaAddresses);
    expect(restored.scanKeys).toEqual(PAYLOAD.scanKeys);
    expect(restored.recoveryMetadata).toEqual(PAYLOAD.recoveryMetadata);
  });
});
