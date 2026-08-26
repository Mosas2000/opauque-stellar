/**
 * Runtime metrics for the ASP HTTP server: tick duration, publication lag, and failure
 * counters exposed at `/metrics` (Prometheus exposition format) and consumed by `/health`.
 */
export interface AspMetrics {
  startedAt: string;
  totalTicks: number;
  totalFailures: number;
  consecutiveFailures: number;
  totalPublished: number;
  totalStatePublished: number;
  totalHaltedForReorg: number;
  totalStaleAlerts: number;
  lastTickAt: string | null;
  lastTickDurationMs: number | null;
  lastTickError: string | null;
  lastPublishAt: string | null;
  lastPublishedRoot: string | null;
}

export function createAspMetrics(): AspMetrics {
  return {
    startedAt: new Date().toISOString(),
    totalTicks: 0,
    totalFailures: 0,
    consecutiveFailures: 0,
    totalPublished: 0,
    totalStatePublished: 0,
    totalHaltedForReorg: 0,
    totalStaleAlerts: 0,
    lastTickAt: null,
    lastTickDurationMs: null,
    lastTickError: null,
    lastPublishAt: null,
    lastPublishedRoot: null,
  };
}

export interface TickOutcome {
  published?: boolean;
  statePublished?: boolean;
  haltedForReorg?: boolean;
  staleAlert?: unknown;
  localRoot?: string;
}

export function recordTickSuccess(
  metrics: AspMetrics,
  res: TickOutcome,
  durationMs: number,
  now: () => string = () => new Date().toISOString(),
): void {
  metrics.totalTicks += 1;
  metrics.lastTickAt = now();
  metrics.lastTickDurationMs = durationMs;
  metrics.lastTickError = null;
  metrics.consecutiveFailures = 0;
  if (res.published) metrics.totalPublished += 1;
  if (res.statePublished) metrics.totalStatePublished += 1;
  if (res.published || res.statePublished) {
    metrics.lastPublishAt = metrics.lastTickAt;
    metrics.lastPublishedRoot = res.localRoot ?? metrics.lastPublishedRoot;
  }
  if (res.haltedForReorg) metrics.totalHaltedForReorg += 1;
  if (res.staleAlert) metrics.totalStaleAlerts += 1;
}

export function recordTickFailure(
  metrics: AspMetrics,
  err: unknown,
  durationMs: number,
  now: () => string = () => new Date().toISOString(),
): void {
  metrics.totalTicks += 1;
  metrics.totalFailures += 1;
  metrics.consecutiveFailures += 1;
  metrics.lastTickAt = now();
  metrics.lastTickDurationMs = durationMs;
  metrics.lastTickError = err instanceof Error ? err.message : String(err);
}

/** Age (ms) of the last published root, or `null` if nothing has published yet. */
export function rootAgeMs(metrics: AspMetrics, now: number = Date.now()): number | null {
  if (!metrics.lastPublishAt) return null;
  return now - Date.parse(metrics.lastPublishAt);
}

export function formatPrometheusMetrics(metrics: AspMetrics): string {
  const lines: string[] = [];
  const gauge = (help: string, name: string, value: number) => {
    lines.push(`# HELP ${name} ${help}`);
    lines.push(`# TYPE ${name} gauge`);
    lines.push(`${name} ${value}`);
  };
  const counter = (help: string, name: string, value: number) => {
    lines.push(`# HELP ${name} ${help}`);
    lines.push(`# TYPE ${name} counter`);
    lines.push(`${name} ${value}`);
  };

  counter("Total number of reconcile ticks attempted.", "asp_total_ticks", metrics.totalTicks);
  counter("Total number of failed reconcile ticks.", "asp_total_failures", metrics.totalFailures);
  gauge(
    "Number of consecutive failed reconcile ticks.",
    "asp_consecutive_failures",
    metrics.consecutiveFailures,
  );  counter("Total number of ASP root publications.", "asp_total_published", metrics.totalPublished);
  counter(
    "Total number of pool state root publications.",
    "asp_total_state_published",
    metrics.totalStatePublished,
  );
  counter(
    "Total number of ticks halted by the reorg guard.",
    "asp_total_halted_for_reorg",
    metrics.totalHaltedForReorg,
  );
  counter(
    "Total number of publication staleness alerts fired.",
    "asp_total_stale_alerts",
    metrics.totalStaleAlerts,
  );
  gauge(
    "Duration of the last reconcile tick in milliseconds.",
    "asp_last_tick_duration_ms",
    metrics.lastTickDurationMs ?? -1,
  );
  gauge(
    "Age of the last published root in milliseconds (publication lag). -1 if nothing published yet.",
    "asp_publication_lag_ms",
    rootAgeMs(metrics) ?? -1,
  );
  gauge(
    "Seconds since the ASP process started.",
    "asp_uptime_seconds",
    (Date.now() - Date.parse(metrics.startedAt)) / 1000,
  );

  return lines.join("\n") + "\n";
}
