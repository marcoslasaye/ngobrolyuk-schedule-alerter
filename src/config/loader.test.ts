/**
 * Tests for config loader (YAML read + Zod validate + env interpolation).
 */
import { describe, it, expect, afterEach } from "vitest";
import { loadConfig, readYamlFile, interpolateEnv } from "./loader.js";

const VALID_YAML = `
teacherId: "marcos"
dateRange: 7
pollIntervalMs: 1800000
quietHours:
  start: "22:00"
  end: "06:00"
  tz: "Asia/Makassar"
whatsapp:
  provider: "callmebot"
  apiKey: "\${WHATSAPP_API_KEY}"
  phone: "\${WHATSAPP_PHONE}"
fallback:
  type: "email"
  config:
    smtpHost: "smtp.gmail.com"
    to: "marcos@example.com"
    user: "\${SMTP_USER}"
    pass: "\${SMTP_PASS}"
    from: "\${SMTP_USER}"
cachePath: "~/.schedule-cache/"
`;

describe("interpolateEnv", () => {
  afterEach(() => {
    delete process.env.WHATSAPP_API_KEY;
    delete process.env.WHATSAPP_PHONE;
  });

  it("replaces \${VAR} placeholders with environment values", () => {
    process.env.WHATSAPP_API_KEY = "KEY123";
    process.env.WHATSAPP_PHONE = "628123456789";
    expect(interpolateEnv("${WHATSAPP_API_KEY}")).toBe("KEY123");
    expect(interpolateEnv("phone: ${WHATSAPP_PHONE}")).toBe("phone: 628123456789");
  });

  it("triangulates: leaves plain strings unchanged", () => {
    expect(interpolateEnv("plain text")).toBe("plain text");
    expect(interpolateEnv("a${NOT_SET}b")).toBe("a${NOT_SET}b");
    expect(interpolateEnv("")).toBe("");
  });
});

describe("readYamlFile", () => {
  it("parses a YAML string into an object", () => {
    const obj = readYamlFile(VALID_YAML);
    expect(obj.teacherId).toBe("marcos");
    expect(obj.quietHours.tz).toBe("Asia/Makassar");
    expect(obj.whatsapp.apiKey).toBe("${WHATSAPP_API_KEY}");
  });
});

describe("loadConfig", () => {
  afterEach(() => {
    delete process.env.WHATSAPP_API_KEY;
    delete process.env.WHATSAPP_PHONE;
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASS;
  });

  it("loads config from a yaml string, interpolating env vars", () => {
    process.env.WHATSAPP_API_KEY = "REAL_KEY";
    process.env.WHATSAPP_PHONE = "628111222333";
    process.env.SMTP_USER = "marcos@gmail.com";
    process.env.SMTP_PASS = "apppass";

    const config = loadConfig(VALID_YAML);
    expect(config.teacherId).toBe("marcos");
    expect(config.dateRange).toBe(7);
    expect(config.pollIntervalMs).toBe(1800000);
    expect(config.whatsapp.provider).toBe("callmebot");
    expect(config.whatsapp.apiKey).toBe("REAL_KEY");
    expect(config.whatsapp.phone).toBe("628111222333");
    expect(config.fallback.type).toBe("email");
    expect(config.fallback.config.to).toBe("marcos@example.com");
    expect(config.fallback.config.smtpHost).toBe("smtp.gmail.com");
    expect(config.cachePath).toBe("~/.schedule-cache/");
  });

  it("throws when a required field is missing", () => {
    const bad = VALID_YAML.replace('teacherId: "marcos"', "");
    expect(() => loadConfig(bad)).toThrow();
  });

  it("interpolates nested \${VAR} values inside fallback config", () => {
    process.env.SMTP_USER = "u@gmail.com";
    process.env.SMTP_PASS = "p";
    const config = loadConfig(VALID_YAML);
    expect(config.fallback.config.user).toBe("u@gmail.com");
    expect(config.fallback.config.pass).toBe("p");
    expect(config.fallback.config.from).toBe("u@gmail.com");
  });
});
