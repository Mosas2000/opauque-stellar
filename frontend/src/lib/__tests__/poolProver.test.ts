import { describe, expect, it } from "vitest";
import { computeContext } from "../poolProver";

const RECIPIENT = "GCMPINZMMQVQ7MWIJLB34F5JRAHLQQTWCP6XB5HEZR353PPPWRUWHLPU";
const RELAYER = "GA5XIGA5C7QTPTWXQHY6MCJRMTRZDOSHR6EFIBNDQTCQHG262N4GGKTM";

describe("poolProver", () => {
  it("derives a deterministic context vector", () => {
    const context = computeContext(
      RECIPIENT,
      123_456_789n,
      1_000n,
      RELAYER,
      42,
    );

    expect(context).toBe(
      computeContext(RECIPIENT, 123_456_789n, 1_000n, RELAYER, 42),
    );
  });

  it("changes when any input changes", () => {
    const base = computeContext(
      RECIPIENT,
      123_456_789n,
      1_000n,
      RELAYER,
      42,
    );
    const changed = computeContext(
      RECIPIENT,
      123_456_790n,
      1_000n,
      RELAYER,
      42,
    );
    expect(changed).not.toBe(base);
  });

  it("rejects malformed Stellar addresses", () => {
    expect(() =>
      computeContext("not-an-address", 1n, 2n, RELAYER, 1),
    ).toThrow();
  });
});
