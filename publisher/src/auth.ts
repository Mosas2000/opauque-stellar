/**
 * Bearer-token authentication for the publisher HTTP API.
 *
 * Two independent tokens are read from the environment:
 *   PUBLISHER_SUBMIT_TOKENS     - comma-separated tokens allowed to POST /v1/reputation/leaves
 *   PUBLISHER_OPERATOR_TOKENS   - comma-separated tokens allowed to read operator-only
 *                                 endpoints (quarantine, /metrics)
 *
 * Issuance flow: an operator generates a random token (e.g. `openssl rand -hex 32`),
 * adds it to the relevant PUBLISHER_*_TOKENS env var, and hands it to the holder/service
 * out of band. Tokens are compared with a constant-time check to avoid timing leaks.
 */
import { timingSafeEqual } from "node:crypto";

function parseTokenList(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t.length > 0),
  );
}

function constantTimeIncludes(tokens: Set<string>, candidate: string): boolean {
  let found = false;
  const candidateBuf = Buffer.from(candidate, "utf8");
  for (const token of tokens) {
    const tokenBuf = Buffer.from(token, "utf8");
    if (tokenBuf.length !== candidateBuf.length) continue;
    if (timingSafeEqual(tokenBuf, candidateBuf)) found = true;
  }
  return found;
}

export interface AuthConfig {
  submitTokens: Set<string>;
  operatorTokens: Set<string>;
}

export function loadAuthConfigFromEnv(): AuthConfig {
  return {
    submitTokens: parseTokenList(process.env.PUBLISHER_SUBMIT_TOKENS),
    operatorTokens: parseTokenList(process.env.PUBLISHER_OPERATOR_TOKENS),
  };
}

function extractBearerToken(req): string | null {
  const header = req.headers["authorization"];
  if (typeof header !== "string") return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

export function isAuthorizedSubmitter(req, cfg: AuthConfig): boolean {
  const token = extractBearerToken(req);
  if (!token) return false;
  return constantTimeIncludes(cfg.submitTokens, token);
}

export function isAuthorizedOperator(req, cfg: AuthConfig): boolean {
  const token = extractBearerToken(req);
  if (!token) return false;
  return constantTimeIncludes(cfg.operatorTokens, token);
}
