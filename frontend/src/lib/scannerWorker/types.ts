/** Message types for the scanner Web Worker (#401). */

/** A single announcement to check against the recipient's keys. */
export interface ScannerAnnouncement {
  /** Announcement record ID from IndexedDB. */
  id: string;
  stealthAddress: string;
  viewTag: number;
  ephemeralPubKeyHex: string;
}

/**
 * Request sent from the main thread to the scanner worker.
 * viewPrivkeyBuffer and spendPubkeyBuffer are transferred (zero-copy)
 * so the main thread must not reference them after postMessage.
 */
export interface ScannerWorkerScanRequest {
  id: string;
  type: "scan";
  announcements: ScannerAnnouncement[];
  /** Transferred ArrayBuffer containing the 32-byte viewing private key. */
  viewPrivkeyBuffer: ArrayBuffer;
  /** Transferred ArrayBuffer containing the 33-byte compressed spending public key. */
  spendPubkeyBuffer: ArrayBuffer;
  /** Number of announcements to process per internal chunk. */
  chunkSize: number;
}

export interface ScannerWorkerCancelRequest {
  id: string;
  type: "cancel";
}

export type ScannerWorkerRequest = ScannerWorkerScanRequest | ScannerWorkerCancelRequest;

export type ScannerWorkerResponse =
  | {
      id: string;
      type: "progress";
      processed: number;
      total: number;
      percent: number;
    }
  | {
      id: string;
      type: "success";
      /** IDs of announcements that matched this recipient's keys. */
      matchedIds: string[];
    }
  | {
      id: string;
      type: "error";
      message: string;
    };
