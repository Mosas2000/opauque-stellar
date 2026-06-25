#!/usr/bin/env tsx
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

type StellarSdk = typeof import("@stellar/stellar-sdk");

type Args = {
  network: "testnet" | "mainnet";
  dryRun: boolean;
  source?: string;
  contractId?: string;
  schemaId: string;
  stealthHash: string;
  data: string;
  refUid: string;
  expirationLedger: number;
};

const DEFAULT_SCHEMA_ID = "0x" + "11".repeat(32);
const DEFAULT_STEALTH_HASH = "0x" + "22".repeat(32);
const DEFAULT_REF_UID = "0x" + "00".repeat(32);

function usage(): string {
  return [
    "Usage: tsx examples/simulate-attest.ts [--dry-run] [--network testnet]",
    "       --source G... --contract-id C... [--schema-id 0x...] [--data 0x...]",
    "",
    "Defaults are testnet manifest, zero expiration, empty data, and sample 32-byte ids.",
  ].join("\n");
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    network: "testnet",
    dryRun: false,
    schemaId: DEFAULT_SCHEMA_ID,
    stealthHash: DEFAULT_STEALTH_HASH,
    data: "0x",
    refUid: DEFAULT_REF_UID,
    expirationLedger: 0,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (!value) throw new Error(`Missing value for ${arg}`);
      i += 1;
      return value;
    };
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--network") {
      const value = next();
      if (value !== "testnet" && value !== "mainnet") {
        throw new Error("--network must be testnet or mainnet");
      }
      args.network = value;
    } else if (arg === "--source") {
      args.source = next();
    } else if (arg === "--contract-id") {
      args.contractId = next();
    } else if (arg === "--schema-id") {
      args.schemaId = next();
    } else if (arg === "--stealth-hash") {
      args.stealthHash = next();
    } else if (arg === "--data") {
      args.data = next();
    } else if (arg === "--ref-uid") {
      args.refUid = next();
    } else if (arg === "--expiration-ledger") {
      args.expirationLedger = Number(next());
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function hexToBytes(hex: string, expectedLen?: number): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (h.length % 2 !== 0) throw new Error(`Invalid hex length: ${hex}`);
  const out = Uint8Array.from(Buffer.from(h, "hex"));
  if (expectedLen !== undefined && out.length !== expectedLen) {
    throw new Error(`Expected ${expectedLen} bytes, got ${out.length}`);
  }
  return out;
}

function loadManifest(network: Args["network"]) {
  const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const manifestPath = resolve(root, "deployments", "v1", `${network}.json`);
  return JSON.parse(readFileSync(manifestPath, "utf8")) as {
    rpcUrl?: string;
    networkPassphrase: string;
    contracts?: { attestationEngineV2?: { id?: string } };
  };
}

async function loadStellarSdk(): Promise<StellarSdk> {
  try {
    return await import("@stellar/stellar-sdk");
  } catch {
    return await import("../frontend/node_modules/@stellar/stellar-sdk/lib/index.js");
  }
}

function printPlan(args: Args, contractId: string, rpcUrl: string | undefined) {
  console.log("Opaque attest() simulation plan");
  console.log(JSON.stringify(
    {
      network: args.network,
      rpcUrl,
      contractId,
      method: "attest",
      source: args.source ?? "(required for live simulation)",
      args: {
        issuer: args.source ?? "(same as source)",
        schema_id: args.schemaId,
        stealth_address_hash: args.stealthHash,
        data: args.data,
        expiration_ledger: args.expirationLedger,
        ref_uid: args.refUid,
      },
      expectedFootprint: {
        readOnly: ["schema-registry config/schema records", "issuer authorization state"],
        readWrite: ["attestation-engine-v2 attestation record", "issuance sequence", "metrics counters"],
      },
    },
    null,
    2,
  ));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifest = loadManifest(args.network);
  const contractId = args.contractId || manifest.contracts?.attestationEngineV2?.id || "";
  printPlan(args, contractId || "(manifest id missing)", manifest.rpcUrl);

  hexToBytes(args.schemaId, 32);
  hexToBytes(args.stealthHash, 32);
  hexToBytes(args.refUid, 32);
  hexToBytes(args.data);
  if (!Number.isInteger(args.expirationLedger) || args.expirationLedger < 0) {
    throw new Error("--expiration-ledger must be a non-negative integer");
  }

  if (args.dryRun) {
    console.log("Dry run complete. No RPC request was sent.");
    return;
  }
  if (!args.source) throw new Error("--source is required for live simulation");
  if (!contractId) throw new Error("Missing attestationEngineV2 contract ID in manifest; pass --contract-id");
  if (!manifest.rpcUrl) throw new Error(`Missing RPC URL for ${args.network}`);

  const {
    Account,
    BASE_FEE,
    Contract,
    TransactionBuilder,
    nativeToScVal,
    rpc,
    scValToNative,
  } = await loadStellarSdk();
  const server = new rpc.Server(manifest.rpcUrl, {
    allowHttp: manifest.rpcUrl.startsWith("http://"),
  });
  const contract = new Contract(contractId);
  const source = new Account(args.source, "0");
  const tx = new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase: manifest.networkPassphrase,
  })
    .addOperation(
      contract.call(
        "attest",
        nativeToScVal(args.source, { type: "address" }),
        nativeToScVal(Buffer.from(hexToBytes(args.schemaId, 32)), { type: "bytes" }),
        nativeToScVal(Buffer.from(hexToBytes(args.stealthHash, 32)), { type: "bytes" }),
        nativeToScVal(Buffer.from(hexToBytes(args.data)), { type: "bytes" }),
        nativeToScVal(args.expirationLedger, { type: "u32" }),
        nativeToScVal(Buffer.from(hexToBytes(args.refUid, 32)), { type: "bytes" }),
      ),
    )
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (!("result" in sim) || !sim.result) {
    console.log(JSON.stringify(sim, null, 2));
    throw new Error("Simulation did not return a successful result");
  }

  console.log("Simulation result");
  console.log(JSON.stringify({
    retval: scValToNative(sim.result.retval),
    minResourceFee: "minResourceFee" in sim ? sim.minResourceFee : undefined,
    footprint: "transactionData" in sim ? sim.transactionData?.build().toXDR("base64") : undefined,
  }, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
