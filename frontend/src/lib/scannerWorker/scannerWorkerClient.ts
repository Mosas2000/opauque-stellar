/**
 * Client interface for the scanner Web Worker.
 * Spawns a module worker that runs WASM announcement matching off the main
 * UI thread, reports progress, and surfaces errors via the returned Promise.
 */

import type {
  ScannerAnnouncement,
  ScannerWorkerRequest,
  ScannerWorkerResponse,
} from "./types";

export type { ScannerAnnouncement };

export type ScannerProgressCallback = (
  processed: number,
  total: number,
  percent: number,
) => void;

export interface ScannerWorkerRunOptions {
  onProgress?: ScannerProgressCallback;
  signal?: AbortSignal;
}

function createJobId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `scan-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function spawnScannerWorker(): Worker {
  return new Worker(new URL("./scannerWorker.ts", import.meta.url), {
    type: "module",
  });
}

/**
 * Scans announcements in a Web Worker using WASM view-tag + address matching.
 *
 * viewPrivkeyBytes and spendPubkeyBytes are TRANSFERRED to the worker
 * (zero-copy). Do not use them in the main thread after calling this function.
 *
 * @returns IDs of announcements that matched the recipient's keys.
 */
export function scanAnnouncementsInWorker(
  announcements: ScannerAnnouncement[],
  viewPrivkeyBytes: Uint8Array,
  spendPubkeyBytes: Uint8Array,
  chunkSize: number,
  options: ScannerWorkerRunOptions = {},
): Promise<string[]> {
  const { onProgress, signal } = options;

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Scanner worker cancelled before start."));
      return;
    }

    const worker = spawnScannerWorker();
    const jobId = createJobId();

    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
      worker.terminate();
    };

    const onAbort = () => {
      worker.postMessage({
        id: jobId,
        type: "cancel",
      } satisfies ScannerWorkerRequest);
      cleanup();
      reject(new Error("Scanner worker cancelled."));
    };

    signal?.addEventListener("abort", onAbort, { once: true });

    worker.onmessage = (event: MessageEvent<ScannerWorkerResponse>) => {
      const msg = event.data;
      if (msg.id !== jobId) return;

      if (msg.type === "progress") {
        onProgress?.(msg.processed, msg.total, msg.percent);
        return;
      }

      cleanup();

      if (msg.type === "success") {
        resolve(msg.matchedIds);
        return;
      }

      reject(new Error(msg.message));
    };

    worker.onerror = (event) => {
      cleanup();
      reject(new Error(event.message || "Scanner worker failed unexpectedly."));
    };

    // Transfer key buffers to the worker (zero-copy).
    const viewPrivkeyBuffer = viewPrivkeyBytes.buffer.slice(
      viewPrivkeyBytes.byteOffset,
      viewPrivkeyBytes.byteOffset + viewPrivkeyBytes.byteLength,
    );
    const spendPubkeyBuffer = spendPubkeyBytes.buffer.slice(
      spendPubkeyBytes.byteOffset,
      spendPubkeyBytes.byteOffset + spendPubkeyBytes.byteLength,
    );

    worker.postMessage(
      {
        id: jobId,
        type: "scan",
        announcements,
        viewPrivkeyBuffer,
        spendPubkeyBuffer,
        chunkSize,
      } satisfies ScannerWorkerRequest,
      [viewPrivkeyBuffer, spendPubkeyBuffer],
    );
  });
}
