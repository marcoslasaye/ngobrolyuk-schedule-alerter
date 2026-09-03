/**
 * Tests for public exports (src/index.ts).
 *
 * Verifies the runtime public surface: domain functions, classes, and
 * constants are re-exported for the test harness and external consumers.
 *
 * Type-only exports (interfaces, type aliases) are verified by the
 * TypeScript compiler (tsc --noEmit) and are not runtime-testable via
 * `toHaveProperty` on the namespace object.
 */
import { describe, it, expect } from "vitest";
import * as publicApi from "./index.js";

describe("public exports — runtime values", () => {
  it("re-exports the differ engine function (diffEntries)", () => {
    expect(typeof publicApi.diffEntries).toBe("function");
  });

  it("re-exports the formatter function (formatAlert)", () => {
    expect(typeof publicApi.formatAlert).toBe("function");
  });

  it("re-exports formatDate from formatter", () => {
    expect(typeof publicApi.formatDate).toBe("function");
  });

  it("re-exports the WhatsApp send function (sendWhatsApp)", () => {
    expect(typeof publicApi.sendWhatsApp).toBe("function");
  });

  it("re-exports the fallback send function (sendFallback)", () => {
    expect(typeof publicApi.sendFallback).toBe("function");
  });

  it("re-exports the AlertQueue class", () => {
    expect(typeof publicApi.AlertQueue).toBe("function");
  });

  it("re-exports the orchestrator class and factory", () => {
    expect(typeof publicApi.ScheduleOrchestrator).toBe("function");
    expect(typeof publicApi.createOrchestrator).toBe("function");
  });

  it("re-exports cache helpers (loadCache, saveCache)", () => {
    expect(typeof publicApi.loadCache).toBe("function");
    expect(typeof publicApi.saveCache).toBe("function");
  });

  it("re-exports cachePathFor from cache", () => {
    expect(typeof publicApi.cachePathFor).toBe("function");
  });

  it("re-exports the parser function (parseSchedule)", () => {
    expect(typeof publicApi.parseSchedule).toBe("function");
  });

  it("re-exports the fetcher client function (fetchSchedule)", () => {
    expect(typeof publicApi.fetchSchedule).toBe("function");
  });

  it("re-exports computeHash from parser", () => {
    expect(typeof publicApi.computeHash).toBe("function");
  });

  it("re-exports config loader functions", () => {
    expect(typeof publicApi.loadConfig).toBe("function");
    expect(typeof publicApi.loadConfigFile).toBe("function");
    expect(typeof publicApi.resolveConfigPath).toBe("function");
    expect(typeof publicApi.interpolateEnv).toBe("function");
  });
});
