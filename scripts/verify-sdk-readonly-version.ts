// @ts-nocheck
/**
 * Verifies that packages/sdk-readonly's published version tracks the
 * deployment manifest's schemaVersion, per issue #381's acceptance criteria.
 *
 * Usage:
 *   tsx scripts/verify-sdk-readonly-version.ts
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const manifest = JSON.parse(
  readFileSync(join(ROOT, "deployments", "v1", "testnet.json"), "utf8"),
);
const pkg = JSON.parse(
  readFileSync(join(ROOT, "packages", "sdk-readonly", "package.json"), "utf8"),
);

const manifestSemver = manifest.schemaVersion;
const pkgSemver = pkg.version;

if (manifestSemver !== pkgSemver) {
  console.error(
    `sdk-readonly version mismatch: package.json is "${pkgSemver}" but ` +
      `deployments/v1/testnet.json schemaVersion is "${manifestSemver}". ` +
      `Bump packages/sdk-readonly/package.json's "version" to match before publishing.`,
  );
  process.exit(1);
}

console.log(`OK: packages/sdk-readonly@${pkgSemver} tracks manifest schemaVersion ${manifestSemver}`);
