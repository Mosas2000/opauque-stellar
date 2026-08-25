/**
 * Numeric environment variable parsing with fail-fast validation.
 *
 * `Number(process.env.X ?? default)` silently produces `NaN` on any
 * malformed value (a typo, an empty string, stray whitespace), which then
 * propagates into rate limiters, intervals, and confirmation counts —
 * turning a config typo into a service that rejects every request instead
 * of failing loudly at startup. This helper validates once, at startup,
 * and throws a message naming the offending variable.
 */

export interface NumberEnvOptions {
  /** Reject values below this (inclusive bound is allowed). */
  min?: number;
  /** Reject values above this (inclusive bound is allowed). */
  max?: number;
  /** Reject non-integer values (default: false — fractional values allowed). */
  integer?: boolean;
}

/**
 * Parse a required numeric environment variable, or fall back to
 * `defaultValue` when unset. Throws with the variable name if the value is
 * present but not a finite number, or violates `min`/`max`/`integer`.
 */
export function numberEnv(name: string, defaultValue: number, options: NumberEnvOptions = {}): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return validate(name, defaultValue, options);
  return validate(name, parseNumericString(name, raw), options);
}

/**
 * Parse a required numeric environment variable with no default — throws if
 * unset, malformed, or out of range.
 */
export function requiredNumberEnv(name: string, options: NumberEnvOptions = {}): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") {
    throw new Error(`set ${name} (required numeric environment variable)`);
  }
  return validate(name, parseNumericString(name, raw), options);
}

function parseNumericString(name: string, raw: string): number {
  const trimmed = raw.trim();
  const value = Number(trimmed);
  if (!Number.isFinite(value)) {
    throw new Error(`invalid value for ${name}: "${raw}" is not a valid number`);
  }
  return value;
}

function validate(name: string, value: number, options: NumberEnvOptions): number {
  if (!Number.isFinite(value)) {
    throw new Error(`invalid default for ${name}: not a finite number`);
  }
  if (options.integer && !Number.isInteger(value)) {
    throw new Error(`invalid value for ${name}: ${value} must be an integer`);
  }
  if (options.min !== undefined && value < options.min) {
    throw new Error(`invalid value for ${name}: ${value} is below the minimum of ${options.min}`);
  }
  if (options.max !== undefined && value > options.max) {
    throw new Error(`invalid value for ${name}: ${value} is above the maximum of ${options.max}`);
  }
  return value;
}
