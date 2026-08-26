import { describe, expect, it, vi } from "vitest";
import {
  DEPOSIT_FEE_BUFFER_STROOPS,
  MIN_DEPOSIT_STROOPS,
  planPoolSweep,
  quoteStealthSpendable,
} from "../poolSweep";

vi.mock("../stellar", () => ({
  getNativeWithdrawalQuote: vi.fn(async () => ({
    spendableStroops: 12_345_678n,
    minimumBalanceStroops: 1_000_000n,
  })),
}));

describe("poolSweep", () => {
  it("plans a single-note sweep when chunking is disabled", () => {
    const plan = planPoolSweep({
      spendableStroops: 5_000_000n,
      minimumBalanceStroops: 1_000_000n,
      chunkStroops: null,
    });

    expect(plan).toEqual({
      spendableStroops: 5_000_000n,
      minimumBalanceStroops: 1_000_000n,
      chunkStroops: 3_000_000n,
      chunkCount: 1,
      totalDepositStroops: 3_000_000n,
      remainderStroops: 2_000_000n,
    });
  });

  it("refuses deposits below the minimum", () => {
    const plan = planPoolSweep({
      spendableStroops: 10_000_000n,
      minimumBalanceStroops: 1_000_000n,
      chunkStroops: MIN_DEPOSIT_STROOPS - 1n,
    });

    expect(plan.chunkCount).toBe(0);
    expect(plan.totalDepositStroops).toBe(0n);
    expect(plan.remainderStroops).toBe(10_000_000n);
  });

  it("splits a balance into equal chunks", () => {
    const plan = planPoolSweep({
      spendableStroops: 9_000_000n,
      minimumBalanceStroops: 1_000_000n,
      chunkStroops: 2_000_000n,
    });

    expect(plan).toEqual({
      spendableStroops: 9_000_000n,
      minimumBalanceStroops: 1_000_000n,
      chunkStroops: 2_000_000n,
      chunkCount: 2,
      totalDepositStroops: 4_000_000n,
      remainderStroops: 5_000_000n,
    });
    expect(DEPOSIT_FEE_BUFFER_STROOPS).toBe(2_000_000n);
  });

  it("quotes spendable balance through the withdrawal helper", async () => {
    await expect(quoteStealthSpendable("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF")).resolves.toEqual({
      spendableStroops: 12_345_678n,
      minimumBalanceStroops: 1_000_000n,
    });
  });
});
