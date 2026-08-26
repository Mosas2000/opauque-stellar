export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

const SENSITIVE_KEY = /(secret|seed|private|token|password|passphrase|x25519|signature)/i;
const STELLAR_SECRET = /S[A-Z2-7]{55}/g;
const HEX_32 = /0x[a-fA-F0-9]{64}/g;

export function redact(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") {
    return value.replace(STELLAR_SECRET, "[redacted-secret]").replace(HEX_32, "[redacted-32-byte-hex]");
  }
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[redacted-cycle]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redact(item, seen));
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      SENSITIVE_KEY.test(key) ? "[redacted]" : redact(entry, seen),
    ]),
  );
}

export function createLogger(service: string, base: Record<string, unknown> = {}): Logger {
  const write = (level: LogLevel, message: string, fields: Record<string, unknown> = {}) => {
    const payload = redact({
      ts: new Date().toISOString(),
      level,
      service,
      message,
      ...base,
      ...fields,
    });
    const line = JSON.stringify(payload);
    if (level === "error") console.error(line);
    else console.log(line);
  };
  return {
    debug: (message, fields) => write("debug", message, fields),
    info: (message, fields) => write("info", message, fields),
    warn: (message, fields) => write("warn", message, fields),
    error: (message, fields) => write("error", message, fields),
    child: (fields) => createLogger(service, { ...base, ...fields }),
  };
}

export function correlationId(prefix = "tick"): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}