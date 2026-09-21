import { describe, expect, vi, beforeEach, afterEach } from "vitest";

// CONSOLE_LOG_CONFIG is a module-level const evaluated once at import time and
// cached by Node's module system. Each test must reset the module cache and
// re-import to pick up a fresh process.env value.

describe("CONSOLE_LOG_CONFIG.maxLines", () => {
  let maxLinesWithEnv;

  beforeEach(() => {
    maxLinesWithEnv = async (value) => {
      if (value === undefined) {
        delete process.env.CONSOLE_LOG_MAX_LINES;
      } else {
        process.env.CONSOLE_LOG_MAX_LINES = value;
      }
      vi.resetModules();
      const mod = await import("@/shared/constants/config.js");
      return mod.CONSOLE_LOG_CONFIG.maxLines;
    };
  });

  afterEach(() => {
    delete process.env.CONSOLE_LOG_MAX_LINES;
  });

  it("defaults to 200 when CONSOLE_LOG_MAX_LINES is unset", async () => {
    const result = await maxLinesWithEnv(undefined);
    expect(result).toBe(200);
  });

  it("is 500 when CONSOLE_LOG_MAX_LINES=500", async () => {
    const result = await maxLinesWithEnv("500");
    expect(result).toBe(500);
  });

  it("is 1000 when CONSOLE_LOG_MAX_LINES=1000", async () => {
    const result = await maxLinesWithEnv("1000");
    expect(result).toBe(1000);
  });

  it("non-numeric value falls back to 200", async () => {
    const result = await maxLinesWithEnv("abc");
    expect(result).toBe(200);
  });

  it("zero or negative value falls back to 200", async () => {
    expect(await maxLinesWithEnv("0")).toBe(200);
    expect(await maxLinesWithEnv("-5")).toBe(200);
  });

  it("fractional value parses integer part", async () => {
    const result = await maxLinesWithEnv("150.9");
    expect(result).toBe(150);
  });

  it("value with leading sign like -5 falls back to 200", async () => {
    const result = await maxLinesWithEnv("-5");
    expect(result).toBe(200);
  });
});