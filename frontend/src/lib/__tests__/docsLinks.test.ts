import { describe, expect, it } from "vitest";
import { getDocUrl, getUserRecoverySectionUrl } from "../docsLinks";

describe("docsLinks", () => {
  it("builds GitHub doc URLs", () => {
    expect(getDocUrl("user-recovery")).toBe(
      "https://github.com/collinsadi/opaque-stellar/blob/main/README.md#recovery",
    );
  });

  it("builds anchored section URLs without a doubled fragment", () => {
    expect(getUserRecoverySectionUrl("manual-ghost")).toBe(
      "https://github.com/collinsadi/opaque-stellar/blob/main/README.md#recovery",
    );
  });

  it("links to proof submission privacy guidance", () => {
    expect(getDocUrl("proof-submission-privacy")).toBe(
      "https://github.com/collinsadi/opaque-stellar/blob/main/docs/PROOF_SUBMISSION_PRIVACY.md",
    );
  });
});
