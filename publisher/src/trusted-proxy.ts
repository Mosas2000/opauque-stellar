/**
 * Resolves the client address used for rate limiting.
 *
 * X-Forwarded-For is attacker-controlled unless the direct peer is a proxy we
 * configured ourselves. PUBLISHER_TRUSTED_PROXIES lists the socket addresses
 * (comma-separated) allowed to append a trustworthy hop; only that peer's own
 * appended value is honored, never arbitrary earlier hops the client could forge.
 * With no trusted proxies configured, the header is ignored entirely and the raw
 * socket address is used.
 */
export function loadTrustedProxiesFromEnv(): Set<string> {
  return new Set(
    (process.env.PUBLISHER_TRUSTED_PROXIES ?? "")
      .split(",")
      .map((ip) => ip.trim())
      .filter((ip) => ip.length > 0),
  );
}

export function resolveClientSource(req, trustedProxies: Set<string>): string {
  const socketAddress = req.socket.remoteAddress ?? "unknown";
  if (trustedProxies.size === 0 || !trustedProxies.has(socketAddress)) {
    return socketAddress;
  }
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded !== "string" || forwarded.trim().length === 0) return socketAddress;
  const hops = forwarded.split(",").map((h) => h.trim()).filter((h) => h.length > 0);
  return hops.length > 0 ? hops[hops.length - 1] : socketAddress;
}
