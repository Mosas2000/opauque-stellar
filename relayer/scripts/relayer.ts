import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair } from "@stellar/stellar-sdk";
import { createRelayerHttpServer } from "../src/http.ts";
import { RelayerEngine } from "../src/engine.ts";
import { HttpGossipTransport, MemoryGossipTransport } from "../src/gossip.ts";
import { RelayerHub, attachRelayerEngineToGossip } from "../src/hub.ts";
import { StellarRelayerChain } from "../src/chains/stellar.ts";
import { generateX25519Keypair } from "../src/shared/box.ts";
import { bytesToHex, hexToBytes } from "../src/shared/bytes.ts";
import { numberEnv } from "../src/env.ts";
import testnetManifest from "../../deployments/v1/testnet.json" with { type: "json" };

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");

function loadDotEnv() {
  const envPath = join(ROOT, ".env");
  if (!existsSync(envPath)) return;
  for (const raw of readFileSync(envPath, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!key || key in process.env) continue;
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Set ${name}`);
  return value;
}

loadDotEnv();

const manifest = testnetManifest as {
  rpcUrl: string;
  networkPassphrase: string;
  contracts: { relayerRegistry?: { id?: string | null } };
};

const operator = Keypair.fromSecret(required("RELAYER_OPERATOR_SECRET"));
const x25519 = generateX25519Keypair(hexToBytes(required("RELAYER_X25519_SECRET")));
const registryId = process.env.RELAYER_REGISTRY_ID?.trim() || manifest.contracts.relayerRegistry?.id;
if (!registryId) throw new Error("Set RELAYER_REGISTRY_ID or deploy relayerRegistry in the testnet manifest.");

const rpcUrl = process.env.STELLAR_RPC_URL?.trim() || manifest.rpcUrl;
const endpoint = process.env.RELAYER_ENDPOINT?.trim() || "http://127.0.0.1:8787";
const minFee = BigInt(process.env.RELAYER_MIN_FEE ?? "100000");
const endpointPort = new URL(endpoint).port;
const port = numberEnv("RELAYER_PORT", Number(endpointPort || 8787), { min: 1, max: 65535, integer: true });

const chain = new StellarRelayerChain({
  rpcUrl,
  networkPassphrase: process.env.NETWORK_PASSPHRASE?.trim() || manifest.networkPassphrase,
  registryId,
  operator,
});
const engine = new RelayerEngine({
  operator,
  x25519PublicKey: x25519.publicKey,
  x25519SecretKey: x25519.secretKey,
  endpoint,
  minFee,
  chain,
});

const hubUrl = process.env.RELAYER_HUB_URL?.trim();

if (hubUrl) {
  const transport = new HttpGossipTransport(hubUrl);
  await attachRelayerEngineToGossip(engine, transport);
  console.log(`Opaque relayer connected to hub ${hubUrl}`);
  console.log(`operator=${operator.publicKey()}`);
  console.log(`x25519=${bytesToHex(x25519.publicKey)}`);
  console.log(`registry=${registryId}`);
} else {
  const transport = new MemoryGossipTransport();
  const hub = new RelayerHub(transport);
  await hub.start();
  await attachRelayerEngineToGossip(engine, transport);

  const server: ReturnType<typeof createServer> = createRelayerHttpServer(hub);
  server.listen(port, () => {
    console.log(`Opaque relayer gateway listening on ${endpoint}`);
    console.log(`operator=${operator.publicKey()}`);
    console.log(`x25519=${bytesToHex(x25519.publicKey)}`);
    console.log(`registry=${registryId}`);
  });
}
