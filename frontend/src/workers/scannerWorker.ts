/**
 * Scanner Web Worker (#606) with graceful WASM memory-pressure abort (#605).
 *
 * Runs the WASM view-tag + full stealth-address match loop off the main
 * thread so trial decryption over a long announcement history never freezes
 * the UI. Reports progress at a bounded frequency and, if the JS heap
 * approaches its limit mid-scan, aborts cleanly with a resumable cursor
 * instead of letting the WASM module trap on an out-of-memory condition.
 *
 * Loaded via `new Worker(new URL("./scannerWorker.ts", import.meta.url),
 * { type: "module" })` — see `useScannerWorker.ts` for the calling side.
 */

/// <reference lib="webworker" />

// Minimal surface of the WASM module this worker actually calls. Kept in
// sync with `OpaqueWasmModule` in `hooks/useOpaqueWasm.ts`.
interface ScannerWasmModule {
  check_announcement_view_tag_wasm(
    view_tag: number,
    view_privkey_bytes: Uint8Array,
    ephemeral_pubkey_bytes: Uint8Array,
  ): string;
  check_announcement_wasm(
    announcement_stealth_address: string,
    view_tag: number,
    view_privkey_bytes: Uint8Array,
    spend_pubkey_bytes: Uint8Array,
    ephemeral_pubkey_bytes: Uint8Array,
  ): boolean;
}

export interface ScanWorkerAnnouncement {
  /** Position of this announcement in the caller's original array — the resume cursor refers to this. */
  index: number;
  id: string;
  stealthAddress: string;
  viewTag: number;
  ephemeralPubKeyHex: string;
}

export interface ScanWorkerRequest {
  type: "scan";
  requestId: string;
  announcements: ScanWorkerAnnouncement[];
  viewPrivKeyHex: string;
  spendPubKeyHex: string;
  /** Index to resume from (skips announcements before it). Defaults to 0. */
  startIndex?: number;
  /** Minimum ms between progress messages. Default 150ms. */
  progressIntervalMs?: number;
}

export interface ScanWorkerTerminateRequest {
  type: "terminate";
}

export type ScanWorkerInboundMessage = ScanWorkerRequest | ScanWorkerTerminateRequest;

export interface ScanWorkerMatch {
  index: number;
  id: string;
  stealthAddress: string;
}

export interface ScanWorkerProgressMessage {
  type: "progress";
  requestId: string;
  processed: number;
  total: number;
}

export interface ScanWorkerDoneMessage {
  type: "done";
  requestId: string;
  matches: ScanWorkerMatch[];
}

export interface ScanWorkerAbortedMessage {
  type: "aborted";
  requestId: string;
  reason: "memory-pressure";
  /** Pass back as `startIndex` on the next request to continue where this scan left off. */
  resumeFromIndex: number;
  matches: ScanWorkerMatch[];
}

export interface ScanWorkerErrorMessage {
  type: "error";
  requestId: string;
  message: string;
}

export type ScanWorkerOutboundMessage =
  | ScanWorkerProgressMessage
  | ScanWorkerDoneMessage
  | ScanWorkerAbortedMessage
  | ScanWorkerErrorMessage;

/** Fraction of `jsHeapSizeLimit` at which the scan aborts rather than risk a WASM OOM trap. */
export const MEMORY_PRESSURE_RATIO = 0.9;

/** Number of announcements processed between memory-pressure checks. */
export const MEMORY_CHECK_INTERVAL = 500;

/**
 * Reads Chrome's non-standard `performance.memory`. Returns `null` on
 * engines that don't expose it (Firefox, Safari) — callers must treat that
 * as "no signal" rather than "healthy", and fall back to the iteration-count
 * backstop in {@link shouldAbortForMemoryPressure}.
 */
export function readHeapUsageRatio(perf: Performance = performance): number | null {
  const mem = (perf as Performance & {
    memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number };
  }).memory;
  if (!mem || !mem.jsHeapSizeLimit) return null;
  return mem.usedJSHeapSize / mem.jsHeapSizeLimit;
}

/**
 * Decides whether to abort the scan for memory pressure. Uses the precise
 * heap ratio when available; on engines without `performance.memory`, falls
 * back to a hard cap on announcements processed in one scan so a
 * pathologically long history still can't run the worker out of memory
 * unbounded — coarser, but never silently unlimited.
 */
export function shouldAbortForMemoryPressure(
  processedThisScan: number,
  heapRatio: number | null,
  fallbackMaxPerScan = 2_000_000,
): boolean {
  if (heapRatio != null) return heapRatio >= MEMORY_PRESSURE_RATIO;
  return processedThisScan >= fallbackMaxPerScan;
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
  return out;
}

let wasmPromise: Promise<ScannerWasmModule> | null = null;

/** Lazily loads and initializes the WASM module once per worker instance. */
function loadWasm(): Promise<ScannerWasmModule> {
  if (!wasmPromise) {
    wasmPromise = (async () => {
      const mod = (await (Function('return import("/pkg/opauque_scanner.js")')() as Promise<
        Record<string, unknown> & { default: () => Promise<void> }
      >));
      await mod.default();
      return mod as unknown as ScannerWasmModule;
    })();
  }
  return wasmPromise;
}

export async function runScan(
  req: ScanWorkerRequest,
  wasm: ScannerWasmModule,
  post: (msg: ScanWorkerOutboundMessage) => void = postMessage,
): Promise<void> {
  const viewPrivKey = hexToBytes(req.viewPrivKeyHex);
  const spendPubKey = hexToBytes(req.spendPubKeyHex);
  const startIndex = req.startIndex ?? 0;
  const progressIntervalMs = req.progressIntervalMs ?? 150;
  const total = req.announcements.length;

  const matches: ScanWorkerMatch[] = [];
  let lastProgressAt = 0;
  let processedThisScan = 0;

  for (let i = startIndex; i < total; i++) {
    const item = req.announcements[i];

    try {
      const ephemeralPubKey = hexToBytes(item.ephemeralPubKeyHex);
      if (ephemeralPubKey.length === 33) {
        const viewTagResult = wasm.check_announcement_view_tag_wasm(
          item.viewTag,
          viewPrivKey,
          ephemeralPubKey,
        );
        if (viewTagResult !== "NoMatch") {
          let isOurs = false;
          try {
            isOurs = wasm.check_announcement_wasm(
              item.stealthAddress,
              item.viewTag,
              viewPrivKey,
              spendPubKey,
              ephemeralPubKey,
            );
          } catch {
            isOurs = false;
          }
          if (isOurs) {
            matches.push({ index: item.index, id: item.id, stealthAddress: item.stealthAddress });
          }
        }
      }
    } catch {
      // Malformed row: skip it, same behavior as the previous main-thread loop.
    }

    processedThisScan += 1;

    if (processedThisScan % MEMORY_CHECK_INTERVAL === 0) {
      const heapRatio = readHeapUsageRatio();
      if (shouldAbortForMemoryPressure(processedThisScan, heapRatio)) {
        const aborted: ScanWorkerAbortedMessage = {
          type: "aborted",
          requestId: req.requestId,
          reason: "memory-pressure",
          resumeFromIndex: i + 1,
          matches,
        };
        post(aborted);
        return;
      }
    }

    const now = Date.now();
    if (now - lastProgressAt >= progressIntervalMs) {
      lastProgressAt = now;
      const progress: ScanWorkerProgressMessage = {
        type: "progress",
        requestId: req.requestId,
        processed: i - startIndex + 1,
        total: total - startIndex,
      };
      post(progress);
    }
  }

  const done: ScanWorkerDoneMessage = { type: "done", requestId: req.requestId, matches };
  post(done);
}

// Guarded so this module can be imported in non-worker contexts (unit tests
// importing the pure helpers above) without crashing on a missing `self`.
if (typeof self !== "undefined" && typeof self.addEventListener === "function") {
  self.addEventListener("message", (event: MessageEvent<ScanWorkerInboundMessage>) => {
    const msg = event.data;

    if (msg.type === "terminate") {
      self.close();
      return;
    }

    (async () => {
      try {
        const wasm = await loadWasm();
        await runScan(msg, wasm);
      } catch (err) {
        const error: ScanWorkerErrorMessage = {
          type: "error",
          requestId: msg.requestId,
          message: err instanceof Error ? err.message : String(err),
        };
        postMessage(error);
      }
    })();
  });
}
