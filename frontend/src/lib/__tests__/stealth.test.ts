/**
 * Stealth address cryptography tests.
 * Tests key derivation, meta-address handling, and stealth address computation.
 */

import { describe, it, expect, vi } from "vitest";
import { secp256k1 } from "@noble/curves/secp256k1";
import {
  deriveKeysFromSignature,
  keysToStealthMetaAddress,
  stealthMetaAddressToHex,
  parseStealthMetaAddress,
  computeStealthAddressAndViewTag,
  buildGhostAnnouncementPayload,
  buildDomainSeparatedMessage,
  LEGACY_SETUP_MESSAGE,
  type Hex,
} from "../stealth";

describe("Stealth Address Cryptography", () => {
  describe("buildDomainSeparatedMessage", () => {
    it("should build a valid domain-separated message", () => {
      const message = buildDomainSeparatedMessage({
        origin: "https://example.com",
        networkPassphrase: "Test SDF Network ; September 2015",
        walletPublicKey: "GBBD47UZQ2KSYFIUDGFZQ6JSVXHQE4NVJYSDLDBFZ6A7QQMH3LJJMXR4",
        purpose: "viewing and spending keys",
      });

      expect(message).toContain("Opaque Protocol Key Derivation");
      expect(message).toContain("https://example.com");
      expect(message).toContain("Test SDF Network");
      expect(message).toContain("viewing and spending keys");
      expect(message).toContain("Version: 1");
      expect(message).toContain("Opaque Stellar");
    });

    it("should create different messages for different origins", () => {
      const msg1 = buildDomainSeparatedMessage({
        origin: "https://example1.com",
        networkPassphrase: "Test SDF Network ; September 2015",
        walletPublicKey: "GBBD47UZQ2KSYFIUDGFZQ6JSVXHQE4NVJYSDLDBFZ6A7QQMH3LJJMXR4",
        purpose: "viewing and spending keys",
      });

      const msg2 = buildDomainSeparatedMessage({
        origin: "https://example2.com",
        networkPassphrase: "Test SDF Network ; September 2015",
        walletPublicKey: "GBBD47UZQ2KSYFIUDGFZQ6JSVXHQE4NVJYSDLDBFZ6A7QQMH3LJJMXR4",
        purpose: "viewing and spending keys",
      });

      expect(msg1).not.toBe(msg2);
    });
  });

  describe("deriveKeysFromSignature", () => {
    it("should derive viewing and spending keys from a signature", () => {
      const signature = "0x" + "a".repeat(128); // 64-byte hex signature
      const keys = deriveKeysFromSignature(signature);

      expect(keys.viewingKey).toBeInstanceOf(Uint8Array);
      expect(keys.spendingKey).toBeInstanceOf(Uint8Array);
      expect(keys.viewingKey.length).toBe(32);
      expect(keys.spendingKey.length).toBe(32);
    });

    it("should derive keys from signature without 0x prefix", () => {
      const signature = "b".repeat(128); // 64-byte hex signature without prefix
      const keys = deriveKeysFromSignature(signature);

      expect(keys.viewingKey.length).toBe(32);
      expect(keys.spendingKey.length).toBe(32);
    });

    it("should derive different keys from different signatures", () => {
      const sig1 = "0x" + "a".repeat(128);
      const sig2 = "0x" + "b".repeat(128);

      const keys1 = deriveKeysFromSignature(sig1);
      const keys2 = deriveKeysFromSignature(sig2);

      expect(keys1.viewingKey).not.toEqual(keys2.viewingKey);
      expect(keys1.spendingKey).not.toEqual(keys2.spendingKey);
    });

    it("should derive consistent keys from the same signature", () => {
      const signature = "0x" + "c".repeat(128);

      const keys1 = deriveKeysFromSignature(signature);
      const keys2 = deriveKeysFromSignature(signature);

      expect(keys1.viewingKey).toEqual(keys2.viewingKey);
      expect(keys1.spendingKey).toEqual(keys2.spendingKey);
    });
  });

  describe("keysToStealthMetaAddress", () => {
    it("should convert keys to stealth meta-address", () => {
      const viewingKey = new Uint8Array(32).fill(1);
      const spendingKey = new Uint8Array(32).fill(2);

      const result = keysToStealthMetaAddress(viewingKey, spendingKey);

      expect(result.V).toBeInstanceOf(Uint8Array);
      expect(result.S).toBeInstanceOf(Uint8Array);
      expect(result.metaAddress).toBeInstanceOf(Uint8Array);
      expect(result.metaAddress.length).toBe(66); // 33 + 33 bytes
    });

    it("should produce 33-byte compressed public keys", () => {
      const viewingKey = new Uint8Array(32).fill(1);
      const spendingKey = new Uint8Array(32).fill(2);

      const result = keysToStealthMetaAddress(viewingKey, spendingKey);

      expect(result.V.length).toBe(33);
      expect(result.S.length).toBe(33);
    });

    it("should combine public keys in correct order", () => {
      const viewingKey = new Uint8Array(32).fill(1);
      const spendingKey = new Uint8Array(32).fill(2);

      const result = keysToStealthMetaAddress(viewingKey, spendingKey);

      const metaFromKeys = new Uint8Array(66);
      metaFromKeys.set(result.V, 0);
      metaFromKeys.set(result.S, 33);

      expect(result.metaAddress).toEqual(metaFromKeys);
    });
  });

  describe("stealthMetaAddressToHex and parseStealthMetaAddress", () => {
    it("should convert meta-address to hex and back", () => {
      const viewingKey = new Uint8Array(32).fill(1);
      const spendingKey = new Uint8Array(32).fill(2);

      const { metaAddress } = keysToStealthMetaAddress(viewingKey, spendingKey);
      const hex = stealthMetaAddressToHex(metaAddress);

      expect(hex).toMatch(/^0x[0-9a-f]+$/);
      expect(hex.length).toBe(2 + 132); // "0x" + 66 bytes * 2 hex chars

      const parsed = parseStealthMetaAddress(hex);
      expect(parsed.viewPubKey).toEqual(metaAddress.slice(0, 33));
      expect(parsed.spendPubKey).toEqual(metaAddress.slice(33, 66));
    });

    it("should handle hex strings without 0x prefix", () => {
      const viewingKey = new Uint8Array(32).fill(1);
      const spendingKey = new Uint8Array(32).fill(2);

      const { metaAddress } = keysToStealthMetaAddress(viewingKey, spendingKey);
      const hex = stealthMetaAddressToHex(metaAddress);
      const hexWithoutPrefix = hex.slice(2);

      const parsed = parseStealthMetaAddress(hexWithoutPrefix);
      expect(parsed.viewPubKey.length).toBe(33);
      expect(parsed.spendPubKey.length).toBe(33);
    });

    it("should reject invalid meta-address length", () => {
      const shortHex = "0x" + "a".repeat(64); // Only 32 bytes, not 66

      expect(() => parseStealthMetaAddress(shortHex)).toThrow();
    });
  });

  describe("computeStealthAddressAndViewTag", () => {
    it("should produce a fixed result for a fixed ephemeral key", () => {
      vi.spyOn(secp256k1.utils, "randomPrivateKey").mockReturnValue(
        new Uint8Array(32).fill(0xcc),
      );

      const viewingKey = new Uint8Array(32).fill(1);
      const spendingKey = new Uint8Array(32).fill(2);
      const { metaAddress } = keysToStealthMetaAddress(viewingKey, spendingKey);
      const metaHex = stealthMetaAddressToHex(metaAddress);

      const result = computeStealthAddressAndViewTag(metaHex);
      expect(result.ephemeralPriv).toEqual(new Uint8Array(32).fill(0xcc));
      expect(result.ephemeralPubKey).toHaveLength(33);
      expect(result.metadata).toEqual(new Uint8Array([result.viewTag]));
      vi.restoreAllMocks();
    });

    it("should compute stealth address and view tag", () => {
      const viewingKey = new Uint8Array(32).fill(1);
      const spendingKey = new Uint8Array(32).fill(2);

      const { metaAddress } = keysToStealthMetaAddress(viewingKey, spendingKey);
      const metaHex = stealthMetaAddressToHex(metaAddress);

      const result = computeStealthAddressAndViewTag(metaHex);

      expect(result.ephemeralPriv).toBeInstanceOf(Uint8Array);
      expect(result.ephemeralPriv.length).toBe(32);
      expect(result.ephemeralPubKey).toBeInstanceOf(Uint8Array);
      expect(result.ephemeralPubKey.length).toBe(33); // Compressed
      expect(result.stealthAddress).toMatch(/^0x[0-9a-f]{40}$/); // 20-byte hex
      expect(result.stealthStellarAddress).toBeDefined();
      expect(result.viewTag).toBeGreaterThanOrEqual(0);
      expect(result.viewTag).toBeLessThan(256);
      expect(result.metadata.length).toBe(1);
      expect(result.metadata[0]).toBe(result.viewTag);
    });

    it("should produce different results on repeated calls (random ephemeral key)", () => {
      const viewingKey = new Uint8Array(32).fill(1);
      const spendingKey = new Uint8Array(32).fill(2);

      const { metaAddress } = keysToStealthMetaAddress(viewingKey, spendingKey);
      const metaHex = stealthMetaAddressToHex(metaAddress);

      const result1 = computeStealthAddressAndViewTag(metaHex);
      const result2 = computeStealthAddressAndViewTag(metaHex);

      // Ephemeral keys should differ
      expect(result1.ephemeralPriv).not.toEqual(result2.ephemeralPriv);

      // Stealth addresses may differ (due to different ephemeral keys)
      // Note: In DKSAP they may sometimes match, but typically won't
    });
  });

  describe("buildGhostAnnouncementPayload", () => {
    it("should rebuild announcement from ephemeral private key", () => {
      const viewingKey = new Uint8Array(32).fill(1);
      const spendingKey = new Uint8Array(32).fill(2);

      const { metaAddress } = keysToStealthMetaAddress(viewingKey, spendingKey);
      const metaHex = stealthMetaAddressToHex(metaAddress);

      // First compute to get an ephemeral private key
      const computed = computeStealthAddressAndViewTag(metaHex);
      const ephPrivHex = ("0x" + Array.from(computed.ephemeralPriv)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("")) as Hex;

      // Now rebuild
      const rebuilt = buildGhostAnnouncementPayload(metaHex, ephPrivHex);

      expect(rebuilt.stealthAddress).toMatch(/^0x[0-9a-f]{40}$/);
      expect(rebuilt.ephemeralPubKey).toEqual(computed.ephemeralPubKey);
      expect(rebuilt.viewTag).toBe(computed.viewTag);
      expect(rebuilt.metadata[0]).toBe(rebuilt.viewTag);
    });

    it("should accept ephemeral key without 0x prefix", () => {
      const viewingKey = new Uint8Array(32).fill(1);
      const spendingKey = new Uint8Array(32).fill(2);

      const { metaAddress } = keysToStealthMetaAddress(viewingKey, spendingKey);
      const metaHex = stealthMetaAddressToHex(metaAddress);

      const computed = computeStealthAddressAndViewTag(metaHex);
      const ephPrivHexNoPrefix = Array.from(computed.ephemeralPriv)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");

      const rebuilt = buildGhostAnnouncementPayload(metaHex, ephPrivHexNoPrefix);
      expect(rebuilt.stealthAddress).toMatch(/^0x[0-9a-f]{40}$/);
    });

    it("should reject invalid ephemeral key length", () => {
      const viewingKey = new Uint8Array(32).fill(1);
      const spendingKey = new Uint8Array(32).fill(2);

      const { metaAddress } = keysToStealthMetaAddress(viewingKey, spendingKey);
      const metaHex = stealthMetaAddressToHex(metaAddress);

      const shortKey = "0x" + "a".repeat(64); // Only 32 bytes, not 64

      expect(() => buildGhostAnnouncementPayload(metaHex, shortKey)).toThrow();
    });
  });

  describe("Round-trip Key Derivation", () => {
    it("should derive consistent results from signature through meta-address", () => {
      const signature = "0x" + "d".repeat(128);

      const keys1 = deriveKeysFromSignature(signature);
      const { metaAddress: meta1 } = keysToStealthMetaAddress(
        keys1.viewingKey,
        keys1.spendingKey,
      );
      const hex1 = stealthMetaAddressToHex(meta1);

      const keys2 = deriveKeysFromSignature(signature);
      const { metaAddress: meta2 } = keysToStealthMetaAddress(
        keys2.viewingKey,
        keys2.spendingKey,
      );
      const hex2 = stealthMetaAddressToHex(meta2);

      expect(hex1).toBe(hex2);
    });
  });
});
