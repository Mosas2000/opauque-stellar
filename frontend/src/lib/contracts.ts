/**
 * Soroban contract helpers for Stealth Registry and Announcer.
 */

import { nativeToScVal } from "@stellar/stellar-sdk";
import { deployedAddresses } from "../contracts/deployedAddresses";
import { bytesToScVal, invokeContractMethod, u64ToScVal } from "./stellar";

export const ANNOUNCER_CONTRACT_ID = deployedAddresses.stealthAnnouncer;
export const REGISTRY_CONTRACT_ID = deployedAddresses.stealthRegistry;

export const SCHEME_ID_SECP256K1 = 1n;
export const SCHEME_ID_ED25519 = 2n;

export async function announceStealthTransfer(opts: {
  sourcePublicKey: string;
  schemeId: bigint;
  stealthAddress: Uint8Array;
  ephemeralPubKey: Uint8Array;
  metadata: Uint8Array;
  signTransaction: (xdr: string) => Promise<string>;
}): Promise<string> {
  return invokeContractMethod({
    sourcePublicKey: opts.sourcePublicKey,
    contractId: ANNOUNCER_CONTRACT_ID,
    method: "announce",
    args: [
      nativeToScVal(opts.sourcePublicKey, { type: "address" }),
      u64ToScVal(opts.schemeId),
      bytesToScVal(opts.stealthAddress),
      bytesToScVal(opts.ephemeralPubKey),
      bytesToScVal(opts.metadata),
    ],
    signTransaction: opts.signTransaction,
  });
}

export async function registerStealthKeys(opts: {
  sourcePublicKey: string;
  schemeId: bigint;
  stealthMetaAddress: Uint8Array;
  signTransaction: (xdr: string) => Promise<string>;
}): Promise<string> {
  return invokeContractMethod({
    sourcePublicKey: opts.sourcePublicKey,
    contractId: REGISTRY_CONTRACT_ID,
    method: "register_keys",
    args: [
      nativeToScVal(opts.sourcePublicKey, { type: "address" }),
      u64ToScVal(opts.schemeId),
      bytesToScVal(opts.stealthMetaAddress),
    ],
    signTransaction: opts.signTransaction,
  });
}

/** @deprecated use announceStealthTransfer */
export function buildAnnounceInstruction(): never {
  throw new Error("Use announceStealthTransfer() for Stellar Soroban");
}

/** @deprecated use registerStealthKeys */
export function buildRegisterKeysInstruction(): never {
  throw new Error("Use registerStealthKeys() for Stellar Soroban");
}
