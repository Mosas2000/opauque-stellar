import { beforeEach, describe, expect, it, vi } from "vitest";

const poseidon = Object.assign(
  (inputs: bigint[]) => inputs.reduce((sum, value) => sum * 131n + value, 7n),
  {
    F: {
      toObject: (value: unknown) => BigInt(value as bigint),
    },
  },
);

vi.mock("circomlibjs", () => ({
  buildPoseidon: vi.fn(async () => poseidon),
}));

import {
  BN254_R,
  POOL_TREE_DEPTH,
  deriveDeposit,
  getPoseidon,
  hashFields,
  newNoteSecrets,
  randomFieldElement,
  toHex32,
  unspentTotal,
  type PoolNote,
} from "../poolNotes";

describe("poolNotes", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("uses a shared Poseidon instance and derives a fixed deposit vector", async () => {
    const a = await getPoseidon();
    const b = await getPoseidon();
    expect(a).toBe(b);

    const derived = await deriveDeposit({
      value: 5_000_000n,
      scope: 42,
      leafIndex: 3,
      nullifier: 123n,
      secret: 456n,
    });

    expect(derived).toEqual({
      label: 125632n,
      precommitment: 136696n,
      commitment: 85837331125n,
      nullifierHash: 1040n,
    });
  });

  it("hashFields and formatting helpers are stable", () => {
    expect(hashFields(poseidon as never, [1n, 2n, 3n])).toBe(15754063n);
    expect(toHex32(255n)).toBe("0x" + "0".repeat(62) + "ff");
  });

  it("builds fresh secrets and keeps them in field range", () => {
    const secrets = newNoteSecrets();
    expect(secrets.nullifier).not.toBe(secrets.secret);
    expect(BigInt(secrets.nullifier)).toBeLessThan(BN254_R);
    expect(BigInt(secrets.secret)).toBeLessThan(BN254_R);
    expect(randomFieldElement()).toMatch(/^\d+$/);
  });

  it("sums only unspent notes", () => {
    const notes: PoolNote[] = [
      {
        cluster: "testnet",
        value: "100",
        scope: 1,
        leafIndex: 0,
        nullifier: "1",
        secret: "2",
        commitment: "0x01",
        spent: false,
        createdAt: 0,
      },
      {
        cluster: "testnet",
        value: "200",
        scope: 1,
        leafIndex: 1,
        nullifier: "3",
        secret: "4",
        commitment: "0x02",
        spent: true,
        createdAt: 0,
      },
    ];
    expect(unspentTotal(notes)).toBe(100n);
    expect(POOL_TREE_DEPTH).toBe(20);
  });
});
