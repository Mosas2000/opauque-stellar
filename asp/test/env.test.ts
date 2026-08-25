import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { numberEnv, requiredNumberEnv } from "../src/env.ts";

const VAR = "TEST_NUMERIC_VAR";

describe("numberEnv", () => {
  const original = process.env[VAR];

  beforeEach(() => {
    delete process.env[VAR];
  });

  afterEach(() => {
    if (original === undefined) delete process.env[VAR];
    else process.env[VAR] = original;
  });

  it("returns the default when unset", () => {
    expect(numberEnv(VAR, 42)).toBe(42);
  });

  it("returns the default when the value is an empty string", () => {
    process.env[VAR] = "";
    expect(numberEnv(VAR, 42)).toBe(42);
  });

  it("returns the default when the value is only whitespace", () => {
    process.env[VAR] = "   ";
    expect(numberEnv(VAR, 42)).toBe(42);
  });

  it("parses a valid numeric value", () => {
    process.env[VAR] = "15000";
    expect(numberEnv(VAR, 1)).toBe(15000);
  });

  it("trims surrounding whitespace before parsing", () => {
    process.env[VAR] = "  7  ";
    expect(numberEnv(VAR, 1)).toBe(7);
  });

  it("throws naming the variable on a non-numeric value", () => {
    process.env[VAR] = "not-a-number";
    expect(() => numberEnv(VAR, 1)).toThrow(/TEST_NUMERIC_VAR/);
  });

  it("throws on a typo like a trailing letter", () => {
    process.env[VAR] = "15000ms";
    expect(() => numberEnv(VAR, 1)).toThrow(/TEST_NUMERIC_VAR/);
  });

  it("throws on Infinity", () => {
    process.env[VAR] = "Infinity";
    expect(() => numberEnv(VAR, 1)).toThrow(/TEST_NUMERIC_VAR/);
  });

  it("enforces a minimum bound", () => {
    process.env[VAR] = "5";
    expect(() => numberEnv(VAR, 1, { min: 10 })).toThrow(/minimum/);
  });

  it("enforces a maximum bound", () => {
    process.env[VAR] = "70000";
    expect(() => numberEnv(VAR, 1, { max: 65535 })).toThrow(/maximum/);
  });

  it("accepts a value at the exact boundary (inclusive)", () => {
    process.env[VAR] = "65535";
    expect(numberEnv(VAR, 1, { max: 65535 })).toBe(65535);
  });

  it("enforces integer-only when requested", () => {
    process.env[VAR] = "1.5";
    expect(() => numberEnv(VAR, 1, { integer: true })).toThrow(/integer/);
  });

  it("allows fractional values when integer is not requested", () => {
    process.env[VAR] = "1.5";
    expect(numberEnv(VAR, 1)).toBe(1.5);
  });
});

describe("requiredNumberEnv", () => {
  const original = process.env[VAR];

  beforeEach(() => {
    delete process.env[VAR];
  });

  afterEach(() => {
    if (original === undefined) delete process.env[VAR];
    else process.env[VAR] = original;
  });

  it("throws naming the variable when unset", () => {
    expect(() => requiredNumberEnv(VAR)).toThrow(/TEST_NUMERIC_VAR/);
  });

  it("throws when the value is an empty string", () => {
    process.env[VAR] = "";
    expect(() => requiredNumberEnv(VAR)).toThrow(/TEST_NUMERIC_VAR/);
  });

  it("parses a valid value", () => {
    process.env[VAR] = "3";
    expect(requiredNumberEnv(VAR)).toBe(3);
  });

  it("throws on a non-numeric value", () => {
    process.env[VAR] = "abc";
    expect(() => requiredNumberEnv(VAR)).toThrow(/TEST_NUMERIC_VAR/);
  });
});
