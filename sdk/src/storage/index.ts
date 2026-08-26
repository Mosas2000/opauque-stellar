/**
 * Storage abstractions. The SDK never imports a state container (no zustand, no
 * IndexedDB): pool notes, ghost entries, and scan cursors persist through these
 * interfaces. In-memory defaults are provided; a host app plugs its own
 * (zustand/IndexedDB in the browser, fs/sqlite on a server).
 */
import type { PoolNote } from "../crypto/notes";
import type { GhostEntryLike } from "../crypto/backup";

/** Persistence for privacy-pool notes (spending material). */
export interface NoteStore {
  list(): Promise<PoolNote[]>;
  add(note: PoolNote): Promise<void>;
  /** Mark the note with this commitment as spent. */
  markSpent(commitment: string): Promise<void>;
}

/** Persistence for stealth "ghost" entries (ephemeral keys + metadata). */
export interface VaultStore {
  listGhosts(): Promise<GhostEntryLike[]>;
  saveGhost(entry: GhostEntryLike): Promise<void>;
}

/** Persistence for the announcement-scan cursor (last processed ledger). */
export interface ScanStore {
  getCursor(): Promise<number | null>;
  setCursor(ledger: number): Promise<void>;
}

/** In-memory {@link NoteStore}. Notes are keyed by commitment. */
export class MemoryNoteStore implements NoteStore {
  private notes = new Map<string, PoolNote>();
  async list(): Promise<PoolNote[]> {
    return [...this.notes.values()];
  }
  async add(note: PoolNote): Promise<void> {
    this.notes.set(note.commitment, note);
  }
  async markSpent(commitment: string): Promise<void> {
    const note = this.notes.get(commitment);
    if (note) this.notes.set(commitment, { ...note, spent: true });
  }
}

/** In-memory {@link VaultStore}. Ghost entries are keyed by stealth address. */
export class MemoryVaultStore implements VaultStore {
  private entries = new Map<string, GhostEntryLike>();
  async listGhosts(): Promise<GhostEntryLike[]> {
    return [...this.entries.values()];
  }
  async saveGhost(entry: GhostEntryLike): Promise<void> {
    this.entries.set(entry.stealthAddress, entry);
  }
}

/** In-memory {@link ScanStore}. */
export class MemoryScanStore implements ScanStore {
  private cursor: number | null = null;
  async getCursor(): Promise<number | null> {
    return this.cursor;
  }
  async setCursor(ledger: number): Promise<void> {
    this.cursor = ledger;
  }
}

export {
  EncryptedNoteStore,
  EncryptedVaultStore,
  EncryptedScanStore,
  localStorageBackend,
  memoryBackend,
  fileBackend,
  type EncryptedStorageBackend,
} from "./encrypted";
