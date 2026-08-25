import { numberEnv } from "./env.ts";

interface Bucket {
  tokens: number;
  lastRefill: number;
}

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetMs: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly windowMs: number;
  private readonly maxRequests: number;
  private readonly burstSize: number;
  private lastCleanup = Date.now();

  constructor(windowMs = 60_000, maxRequests = 120, burstSize = 20) {
    this.windowMs = windowMs;
    this.maxRequests = maxRequests;
    this.burstSize = burstSize;
  }

  consume(source: string): RateLimitResult {
    const now = Date.now();
    this.maybeCleanup(now);

    let bucket = this.buckets.get(source);
    if (!bucket) {
      bucket = { tokens: this.burstSize, lastRefill: now };
      this.buckets.set(source, bucket);
    }

    const elapsed = now - bucket.lastRefill;
    if (elapsed >= this.windowMs) {
      bucket.tokens = this.burstSize;
      bucket.lastRefill = now;
    } else {
      const refill = (elapsed / this.windowMs) * this.maxRequests;
      bucket.tokens = Math.min(this.burstSize, bucket.tokens + refill);
      bucket.lastRefill = now;
    }

    const resetMs = bucket.lastRefill + this.windowMs;

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return {
        allowed: true,
        limit: this.burstSize,
        remaining: Math.floor(bucket.tokens),
        resetMs,
      };
    }

    return {
      allowed: false,
      limit: this.burstSize,
      remaining: 0,
      resetMs,
    };
  }

  private maybeCleanup(now: number): void {
    if (now - this.lastCleanup < this.windowMs * 2) return;
    this.lastCleanup = now;
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.lastRefill > this.windowMs * 3) {
        this.buckets.delete(key);
      }
    }
  }
}

/** Tight tier: applied only to state-mutating endpoints (job creation, payload delivery, gossip). */
export function createRateLimiterFromEnv(): RateLimiter {
  const windowMs = numberEnv("RATE_LIMIT_WINDOW_MS", 60_000, { min: 1 });
  const maxRequests = numberEnv("RATE_LIMIT_MAX_REQUESTS", 120, { min: 1 });
  const burstSize = numberEnv("RATE_LIMIT_BURST", 20, { min: 1 });
  return new RateLimiter(windowMs, maxRequests, burstSize);
}

/**
 * Loose tier: applied to every request regardless of route, including reads. Catches a
 * flood that spreads across endpoints (e.g. hammering /bids and /health) that the tight,
 * write-only tier above would never see. Generous enough that a single legitimate user
 * — polling bids, checking health, etc. — will not come close to it.
 */
export function createGlobalRateLimiterFromEnv(): RateLimiter {
  const windowMs = numberEnv("RATE_LIMIT_WINDOW_MS", 60_000, { min: 1 });
  const maxRequests = numberEnv("RATE_LIMIT_GLOBAL_MAX_REQUESTS", 600, { min: 1 });
  const burstSize = numberEnv("RATE_LIMIT_GLOBAL_BURST", 200, { min: 1 });
  return new RateLimiter(windowMs, maxRequests, burstSize);
}
