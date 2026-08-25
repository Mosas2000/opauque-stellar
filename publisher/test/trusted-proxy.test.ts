import { describe, expect, it } from "vitest";
import { resolveClientSource } from "../src/trusted-proxy.ts";

function fakeReq(remoteAddress: string, forwardedFor?: string) {
  return {
    socket: { remoteAddress },
    headers: forwardedFor ? { "x-forwarded-for": forwardedFor } : {},
  } as any;
}

describe("resolveClientSource", () => {
  it("uses the socket address when no proxies are trusted", () => {
    const req = fakeReq("203.0.113.9", "1.2.3.4");
    expect(resolveClientSource(req, new Set())).toBe("203.0.113.9");
  });

  it("ignores a spoofed X-Forwarded-For from an untrusted peer", () => {
    const req = fakeReq("198.51.100.1", "10.0.0.1");
    const trusted = new Set(["10.0.0.5"]);
    expect(resolveClientSource(req, trusted)).toBe("198.51.100.1");
  });

  it("honors only the trusted proxy's own appended hop", () => {
    const req = fakeReq("10.0.0.5", "203.0.113.9, 10.0.0.5");
    const trusted = new Set(["10.0.0.5"]);
    expect(resolveClientSource(req, trusted)).toBe("10.0.0.5");
  });

  it("falls back to socket address when the header is missing", () => {
    const req = fakeReq("10.0.0.5");
    const trusted = new Set(["10.0.0.5"]);
    expect(resolveClientSource(req, trusted)).toBe("10.0.0.5");
  });
});
