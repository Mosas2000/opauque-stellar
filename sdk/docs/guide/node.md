# Node (server keypair)

On a server, sign with a raw Stellar keypair and generate proofs from circuit
artifacts on disk.

## Signer

```ts
import { OpaqueClient, keypairSigner } from "@opaquecash/stellar";

const opaque = new OpaqueClient({
  network: "testnet",
  signer: keypairSigner(process.env.STELLAR_SECRET!),
});
```

`keypairSigner` accepts a secret seed (`S...`) or a `Keypair` instance.

## Generating proofs

Circuit `.wasm` / `.zkey` files are large and ship via a release, not the npm
package. Point a resolver at a local directory (or a URL with
`urlArtifactResolver`):

```ts
import { OpaqueClient, fileArtifactResolver, keypairSigner } from "@opaquecash/stellar";

const opaque = new OpaqueClient({
  network: "testnet",
  signer: keypairSigner(process.env.STELLAR_SECRET!),
  artifacts: fileArtifactResolver({ baseDir: "./circuits-dist" }),
});

const proof = await opaque.reputation.prove({
  attestationId,
  stealthPrivKey,
  externalNullifier: 42n,
});
const txHash = await opaque.reputation.verifyOnChain(proof);
```

The resolver looks for `circuits/v2/stealth_reputation.wasm` and
`circuits/v2/stealth_reputation_final.zkey` (reputation), and the `v3`
`privacy_pool_withdraw.*` files (pool) under `baseDir`.

## Clean process exit

`snarkjs` keeps worker threads alive after proving, so a short-lived Node script
won't exit on its own. Call `process.exit(0)` when your work is done:

```ts
await opaque.reputation.verifyOnChain(proof);
process.exit(0);
```

## Runnable example

See [`examples/node-quickstart.mjs`](https://github.com/collinsadi/opaque-stellar/blob/main/sdk/examples/node-quickstart.mjs):

```sh
node examples/node-quickstart.mjs
# also generate a real proof:
OPAQUE_CIRCUITS_DIR=/path/to/public node examples/node-quickstart.mjs
```
