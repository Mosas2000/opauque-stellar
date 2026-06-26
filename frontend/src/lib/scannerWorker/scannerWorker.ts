/**
 * Scanner Web Worker — runs WASM announcement matching off the main UI thread.
 * Processes announcement batches in chunks with progress callbacks (#401).
 */

import "../../polyfills";
import type {
  ScannerAnnouncement,
  ScannerWorkerRequest,
  ScannerWorkerResponse,
} from "./types";

interface WasmModule {
  check_announcement_wasm: (
    stealthAddress: string,
    viewTag: number,
    viewPrivkeyBytes: Uint8Array,
    spendPubkeyBytes: Uint8Array,
    ephemeralPubkeyBytes: Uint8Array,
  ) => boolean;
  check_announcement_view_tag_wasm: (
    viewTag: number,
    viewPrivkeyBytes: Uint8Array,
    ephemeralPubkeyBytes: Uint8Array,
  ) => string;
}

let wasmCache: WasmModule | null = null;

async function loadWasm(): Promise<WasmModule> {
  if (wasmCache) return wasmCache;
  const mod = await (import(/* @vite-ignore */ "/pkg/cryptography.js") as Promise<
    WasmModule & { default: () => Promise<void> }
  >);
  await mod.default();
  wasmCache = mod;
  return wasmCache;
}

function post(msg: ScannerWorkerResponse): void {
  self.postMessage(msg);
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

const cancelledJobs = new Set<string>();

async function handleScan(
  id: string,
  announcements: ScannerAnnouncement[],
  viewPrivkeyBuffer: ArrayBuffer,
  spendPubkeyBuffer: ArrayBuffer,
  chunkSize: number,
): Promise<void> {
  let wasm: WasmModule;
  try {
    wasm = await loadWasm();
  } catch (err) {
    post({
      id,
      type: "error",
      message: `Scanner WASM failed to load: ${err instanceof Error ? err.message : String(err)}`,
    });
    return;
  }

  if (cancelledJobs.has(id)) return;

  const viewPrivkey = new Uint8Array(viewPrivkeyBuffer);
  const spendPubkey = new Uint8Array(spendPubkeyBuffer);
  const total = announcements.length;
  const matchedIds: string[] = [];

  for (let offset = 0; offset < total; offset += chunkSize) {
    if (cancelledJobs.has(id)) return;

    const chunk = announcements.slice(offset, offset + chunkSize);

    for (const ann of chunk) {
      if (!ann.stealthAddress || !ann.ephemeralPubKeyHex) continue;
      try {
        const ephBytes = hexToBytes(ann.ephemeralPubKeyHex);
        if (ephBytes.length !== 33) continue;

        const tagResult = wasm.check_announcement_view_tag_wasm(
          ann.viewTag,
          viewPrivkey,
          ephBytes,
        );
        if (tagResult === "NoMatch") continue;

        const isMatch = wasm.check_announcement_wasm(
          ann.stealthAddress,
          ann.viewTag,
          viewPrivkey,
          spendPubkey,
          ephBytes,
        );
        if (isMatch) matchedIds.push(ann.id);
      } catch {
        // Skip malformed announcements without aborting the batch.
      }
    }

    const processed = Math.min(offset + chunkSize, total);
    post({
      id,
      type: "progress",
      processed,
      total,
      percent: Math.round((processed / total) * 100),
    });
  }

  post({ id, type: "success", matchedIds });
}

self.onmessage = (event: MessageEvent<ScannerWorkerRequest>) => {
  const msg = event.data;

  if (msg.type === "cancel") {
    cancelledJobs.add(msg.id);
    return;
  }

  if (msg.type === "scan") {
    void handleScan(
      msg.id,
      msg.announcements,
      msg.viewPrivkeyBuffer,
      msg.spendPubkeyBuffer,
      msg.chunkSize,
    ).finally(() => {
      cancelledJobs.delete(msg.id);
    });
  }
};
