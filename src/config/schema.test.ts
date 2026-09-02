/**
 * Tests for config schema (Zod) — verifies parsing, defaults, and validation.
 */
import { describe, it, expect } from "vitest";
import { ConfigSchema, parseConfig, validateConfig } from "./schema.js";

const validRaw = {
  teacherId: "marcos",
  dateRange: 7,
  pollIntervalMs: 1800000,
  quietHours: { start: "22:00", end: "06:00", tz: "Asia/Makassar" },
  whatsapp: { provider: "callmebot", apiKey: "KEY123", phone: "628123456789" },
  fallback: { type: "email", config: { smtpHost: "smtp.gmail.com", to: "a@b.com", user: "u", pass: "p", from: "u" } },
  cachePath: "~/.schedule-cache/",
};

describe("ConfigSchema", () => {
  it("parses a fully valid config object", () => {
    const config = parseConfig(validRaw);
    expect(config.teacherId).toBe("marcos");
    expect(config.dateRange).toBe(7);
    expect(config.pollIntervalMs).toBe(1800000);
    expect(config.quietHours.start).toBe("22:00");
    expect(config.quietHours.end).toBe("06:00");
    expect(config.quietHours.tz).toBe("Asia/Makassar");
    expect(config.whatsapp.provider).toBe("callmebot");
    expect(config.whatsapp.apiKey).toBe("KEY123");
    expect(config.whatsapp.phone).toBe("628123456789");
    expect(config.fallback.type).toBe("email");
    expect(config.cachePath).toBe("~/.schedule-cache/");
  });

  it("applies defaults for dateRange and pollIntervalMs", () => {
    const config = parseConfig({ ...validRaw, dateRange: undefined as any, pollIntervalMs: undefined as any });
    expect(config.dateRange).toBe(7);
    expect(config.pollIntervalMs).toBe(1800000);
  });

  it("rejects config missing required teacherId", () => {
    const { teacherId, ...without } = validRaw;
    expect(() => parseConfig(without)).toThrow();
  });

  it("rejects invalid quietHours time format", () => {
    expect(() => parseConfig({ ...validRaw, quietHours: { ...validRaw.quietHours, start: "22:00:00" } })).toThrow();
  });

  it("validates fallback type enum", () => {
    expect(() => parseConfig({ ...validRaw, fallback: { ...validRaw.fallback, type: "sms" } })).toThrow();
  });

  it("validateConfig returns true for valid and false for invalid", () => {
    expect(validateConfig(validRaw)).toBe(true);
    const { teacherId: _t, ...without } = validRaw;
    expect(validateConfig(without)).toBe(false);
  });
});
