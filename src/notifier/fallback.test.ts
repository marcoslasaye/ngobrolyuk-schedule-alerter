/**
 * Tests for the notifier fallback clients (email / telegram / file-log).
 *
 * Mocks nodemailer's transport and telegraf's Telegraf class to verify
 * dispatch by fallback type without touching real external services.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const { sendMailMock, sendMessageMock, TelegrafMock } = vi.hoisted(() => {
  const sendMailMock = vi.fn();
  const sendMessageMock = vi.fn();
  return {
    sendMailMock,
    sendMessageMock,
    TelegrafMock: class {
      telegram: { sendMessage: typeof sendMessageMock };
      constructor(_token: string) {
        void _token;
        this.telegram = { sendMessage: sendMessageMock };
      }
    },
  };
});

vi.mock("nodemailer", () => ({
  default: {
    createTransport: () => ({ sendMail: sendMailMock }),
  },
}));

vi.mock("telegraf", () => ({
  Telegraf: TelegrafMock,
}));

import { sendFallback, type FallbackConfig } from "./fallback.js";

function emailConfig(overrides: Record<string, string | number | boolean> = {}) {
  const fc: FallbackConfig = {
    type: "email",
    config: {
      smtpHost: "smtp.gmail.com",
      to: "marcos@example.com",
      ...overrides,
    },
  };
  return fc;
}

function telegramConfig() {
  const fc: FallbackConfig = {
    type: "telegram",
    config: { botToken: "tok123", chatId: "12345" },
  };
  return fc;
}

beforeEach(() => {
  sendMailMock.mockReset();
  sendMessageMock.mockReset();
});

describe("sendFallback", () => {
  it("delivers email via nodemailer when type is email", async () => {
    sendMailMock.mockResolvedValueOnce({ messageId: "m1" });
    const result = await sendFallback(
      "📅 Schedule Change Alert\n[➕ Added] Juan — Sep 5, 10:00",
      emailConfig(),
    );
    expect(sendMailMock).toHaveBeenCalledTimes(1);
    const mail = sendMailMock.mock.calls[0][0];
    expect(mail.to).toBe("marcos@example.com");
    expect(mail.subject).toContain("Schedule");
    expect(mail.text).toContain("Juan");
    expect(result.success).toBe(true);
    expect(result.channel).toBe("email");
  });

  it("delivers telegram when type is telegram", async () => {
    sendMessageMock.mockResolvedValueOnce({ message_id: 1 });
    const result = await sendFallback("📅 Alert text", telegramConfig());
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock).toHaveBeenCalledWith(
      "12345",
      "📅 Alert text",
    );
    expect(result.success).toBe(true);
    expect(result.channel).toBe("telegram");
  });

  it("writes a file log when type is none and reports success", async () => {
    const dir = join(
      "C:\\Users\\Marcos Lopez Sapitri\\AppData\\Local\\Temp\\opencode",
      "fallback-log-test",
    );
    const fc: FallbackConfig = { type: "none", config: { file: dir } };
    const result = await sendFallback("📅 Alert: Juan moved", fc);
    expect(result.success).toBe(true);
    expect(result.channel).toBe("file");
    const logPath = join(dir, "fallback.log");
    expect(existsSync(logPath)).toBe(true);
    expect(readFileSync(logPath, "utf8")).toContain("Juan moved");
  });

  it("returns failure when the email transport rejects", async () => {
    sendMailMock.mockRejectedValueOnce(new Error("SMTP refused"));
    const result = await sendFallback("text", emailConfig());
    expect(result.success).toBe(false);
    expect(result.channel).toBe("email");
    expect(result.error).toContain("SMTP refused");
  });
});
