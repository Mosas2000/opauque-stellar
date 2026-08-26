import { beforeEach, describe, expect, it } from "vitest";
import {
  createEncryptedStorage,
  decryptData,
  encryptData,
  isEncryptedPayload,
  type EncryptedPayload,
} from "../encryptedStorage";

describe("encryptedStorage", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("encrypts and decrypts payloads", async () => {
    const payload = await encryptData({ state: { balance: 42 }, version: 7 }, "passphrase");
    expect(payload.version).toBe(1);
    expect(isEncryptedPayload(payload)).toBe(true);
    expect(JSON.stringify(payload)).not.toContain("balance");

    const restored = await decryptData<{ state: { balance: number }; version: number }>(
      payload,
      "passphrase",
    );
    expect(restored).toEqual({ state: { balance: 42 }, version: 7 });
  });

  it("rejects unsupported versions", async () => {
    await expect(
      decryptData(
        { version: 2, salt: "AA==", data: "AA==" } as EncryptedPayload,
        "passphrase",
      ),
    ).rejects.toThrow("Unsupported encrypted payload version");
  });

  it("round-trips through the storage adapter and supports legacy plaintext", async () => {
    const storage = createEncryptedStorage<{ balance: number }>("store", () => "passphrase");
    await storage.setItem("store", { state: { balance: 99 }, version: 3 });
    const stored = localStorage.getItem("store");
    expect(stored).toContain('"version":1');

    await expect(storage.getItem("store")).resolves.toEqual({
      state: { balance: 99 },
      version: 3,
    });

    localStorage.setItem("legacy", JSON.stringify({ state: { balance: 5 }, version: 1 }));
    await expect(storage.getItem("legacy")).resolves.toEqual({
      state: { balance: 5 },
      version: 1,
    });
  });

  it("returns null when the passphrase is unavailable or wrong", async () => {
    const storage = createEncryptedStorage<{ balance: number }>("store", () => null);
    localStorage.setItem(
      "store",
      JSON.stringify(await encryptData({ state: { balance: 12 }, version: 1 }, "right")),
    );
    await expect(storage.getItem("store")).resolves.toBeNull();

    const wrong = createEncryptedStorage<{ balance: number }>("store", () => "wrong");
    await expect(wrong.getItem("store")).resolves.toBeNull();
  });

  it("removes stored values", () => {
    const storage = createEncryptedStorage("store", () => null);
    localStorage.setItem("store", "value");
    storage.removeItem("store");
    expect(localStorage.getItem("store")).toBeNull();
  });
});
