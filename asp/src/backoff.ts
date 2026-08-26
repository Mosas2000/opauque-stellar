export interface BackoffOptions {
  baseIntervalMs: number;
  maxIntervalMs: number;
  factor?: number;
  jitterRatio?: number;
  random?: () => number;
}

export function backoffDelayMs(failureStreak: number, options: BackoffOptions): number {
  if (failureStreak <= 0) return options.baseIntervalMs;
  const factor = options.factor ?? 2;
  const jitterRatio = options.jitterRatio ?? 0.2;
  const random = options.random ?? Math.random;
  const exponent = Math.max(0, failureStreak - 1);
  const raw = options.baseIntervalMs * Math.pow(factor, exponent);
  const capped = Math.min(raw, options.maxIntervalMs);
  const jitter = capped * jitterRatio * random();
  return Math.round(Math.min(options.maxIntervalMs, capped + jitter));
}