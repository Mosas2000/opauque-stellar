import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RelayerBid } from "./messages.ts";
import type { RelayerHubStats } from "./hub.ts";
import type { JobLedgerEntry } from "./reconciler.ts";

// ---------------------------------------------------------------------------
// Hub state (serialisable snapshot of RelayerHub internals)
// ---------------------------------------------------------------------------

type OutcomeEntry = { result: "completed" | "failed"; at: number };

export type HubState = {
  bids: [string, RelayerBid[]][];
  outcomes: [string, OutcomeEntry[]][];
  knownOperators: string[];
  lastHeartbeatAt: [string, number][];
  assignments: [string, string][];
  stats: RelayerHubStats;
};

export interface HubStore {
  load(): Promise<HubState | null>;
  save(state: HubState): Promise<void>;
  clear(): Promise<void>;
  getBids(): Promise<[string, RelayerBid[]][] | null>;
  getOutcomes(): Promise<[string, OutcomeEntry[]][] | null>;
  getKnownOperators(): Promise<string[] | null>;
  getLastHeartbeatAt(): Promise<[string, number][] | null>;
  getAssignments(): Promise<[string, string][] | null>;
  getStats(): Promise<RelayerHubStats | null>;
}

// ---------------------------------------------------------------------------
// Job ledger store
// ---------------------------------------------------------------------------

export interface LedgerStore {
  load(): Promise<JobLedgerEntry[] | null>;
  save(entries: JobLedgerEntry[]): Promise<void>;
  clear(): Promise<void>;
}

// ---------------------------------------------------------------------------
// In-memory implementations (tests)
// ---------------------------------------------------------------------------

export class MemoryHubStore implements HubStore {
  private state: HubState | null = null;

  async load(): Promise<HubState | null> {
    return this.state;
  }

  async save(state: HubState): Promise<void> {
    this.state = state;
  }

  async clear(): Promise<void> {
    this.state = null;
  }

  async getBids(): Promise<[string, RelayerBid[]][] | null> {
    return this.state?.bids ?? null;
  }

  async getOutcomes(): Promise<[string, OutcomeEntry[]][] | null> {
    return this.state?.outcomes ?? null;
  }

  async getKnownOperators(): Promise<string[] | null> {
    return this.state?.knownOperators ?? null;
  }

  async getLastHeartbeatAt(): Promise<[string, number][] | null> {
    return this.state?.lastHeartbeatAt ?? null;
  }

  async getAssignments(): Promise<[string, string][] | null> {
    return this.state?.assignments ?? null;
  }

  async getStats(): Promise<RelayerHubStats | null> {
    return this.state?.stats ?? null;
  }
}

export class MemoryLedgerStore implements LedgerStore {
  private entries: JobLedgerEntry[] | null = null;

  async load(): Promise<JobLedgerEntry[] | null> {
    return this.entries;
  }

  async save(entries: JobLedgerEntry[]): Promise<void> {
    this.entries = entries;
  }

  async clear(): Promise<void> {
    this.entries = null;
  }
}

// ---------------------------------------------------------------------------
// File-backed implementations
// ---------------------------------------------------------------------------

const HUB_FILE = "hub.json";
const LEDGER_FILE = "ledger.json";
const STATE_VERSION = 1;

function ensureDir(filePath: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function readJsonFile<T>(filePath: string): T | null {
  try {
    if (!existsSync(filePath)) return null;
    return JSON.parse(readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

function writeJsonFile(filePath: string, data: unknown): void {
  ensureDir(filePath);
  writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
}

function serialiseBigInt(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return `__bigint__:${value.toString()}`;
  return value;
}

function deserialiseBigInt(_key: string, value: unknown): unknown {
  if (typeof value === "string" && value.startsWith("__bigint__:")) {
    return BigInt(value.slice("__bigint__:".length));
  }
  return value;
}

export class FileHubStore implements HubStore {
  private filePath: string;

  constructor(dataDir: string) {
    this.filePath = join(dataDir, HUB_FILE);
  }

  async load(): Promise<HubState | null> {
    const raw = readJsonFile<{ version?: number; state: HubState }>(this.filePath);
    if (!raw || raw.version !== STATE_VERSION) return null;
    const s = raw.state;
    return {
      bids: (s.bids ?? []).map(([k, v]) => [k, v]),
      outcomes: (s.outcomes ?? []).map(([k, v]) => [k, v]),
      knownOperators: s.knownOperators ?? [],
      lastHeartbeatAt: (s.lastHeartbeatAt ?? []).map(([k, v]) => [k, v]),
      assignments: (s.assignments ?? []).map(([k, v]) => [k, v]),
      stats: s.stats,
    };
  }

  async save(state: HubState): Promise<void> {
    writeJsonFile(this.filePath, { version: STATE_VERSION, state }, serialiseBigInt);
  }

  async clear(): Promise<void> {
    try {
      const { unlinkSync } = await import("node:fs");
      unlinkSync(this.filePath);
    } catch {
      // ignore
    }
  }

  async getBids(): Promise<[string, RelayerBid[]][] | null> {
    return (await this.load())?.bids ?? null;
  }

  async getOutcomes(): Promise<[string, OutcomeEntry[]][] | null> {
    return (await this.load())?.outcomes ?? null;
  }

  async getKnownOperators(): Promise<string[] | null> {
    return (await this.load())?.knownOperators ?? null;
  }

  async getLastHeartbeatAt(): Promise<[string, number][] | null> {
    return (await this.load())?.lastHeartbeatAt ?? null;
  }

  async getAssignments(): Promise<[string, string][] | null> {
    return (await this.load())?.assignments ?? null;
  }

  async getStats(): Promise<RelayerHubStats | null> {
    return (await this.load())?.stats ?? null;
  }
}

export class FileLedgerStore implements LedgerStore {
  private filePath: string;

  constructor(dataDir: string) {
    this.filePath = join(dataDir, LEDGER_FILE);
  }

  async load(): Promise<JobLedgerEntry[] | null> {
    const raw = readJsonFile<{ version?: number; entries: JobLedgerEntry[] }>(this.filePath);
    if (!raw || raw.version !== STATE_VERSION) return null;
    return (raw.entries ?? []).map((e) => ({
      ...e,
      expectedFee: typeof e.expectedFee === "string"
        ? JSON.parse(e.expectedFee, deserialiseBigInt) as bigint
        : e.expectedFee,
    }));
  }

  async save(entries: JobLedgerEntry[]): Promise<void> {
    writeJsonFile(
      this.filePath,
      {
        version: STATE_VERSION,
        entries: entries.map((e) => ({ ...e, expectedFee: e.expectedFee.toString() })),
      },
      serialiseBigInt,
    );
  }

  async clear(): Promise<void> {
    try {
      const { unlinkSync } = await import("node:fs");
      unlinkSync(this.filePath);
    } catch {
      // ignore
    }
  }
}
