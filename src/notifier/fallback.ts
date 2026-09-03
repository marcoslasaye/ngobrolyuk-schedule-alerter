/**
 * Notifier fallback clients — email (nodemailer/Gmail SMTP), Telegram
 * (telegraf Bot API), or a file log (`none`).
 *
 * `sendFallback` dispatches to the configured channel based on `fc.type`.
 * Email sends a plain-text message via SMTP. Telegram posts to a chat via
 * the Bot API. `none` appends to a local log file. Always returns a
 * DeliveryResult; never throws.
 */
import nodemailer from "nodemailer";
import { Telegraf } from "telegraf";
import { appendFileSync, mkdirSync } from "node:fs";
import type { DeliveryResult } from "./types.js";

/** Fallback channel config as resolved from config.yaml. */
export type FallbackConfig = {
  type: "email" | "telegram" | "none";
  config: Record<string, string | number | boolean>;
};

/** Default log file name used by the `none` (file) channel. */
export const FILE_LOG_NAME = "fallback.log";

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Deliver an email via nodemailer (Gmail SMTP by default). */
async function sendEmail(
  text: string,
  config: Record<string, string | number | boolean>,
): Promise<DeliveryResult> {
  const smtpHost = String(config.smtpHost ?? "smtp.gmail.com");
  const smtpPort = Number(config.smtpPort ?? 465);
  const user = config.user ? String(config.user) : undefined;
  const pass = config.pass ? String(config.pass) : undefined;

  const transporter = nodemailer.createTransport({
    host: smtpHost,
    port: smtpPort,
    secure: smtpPort === 465,
    auth: user && pass ? { user, pass } : undefined,
  });

  try {
    await transporter.sendMail({
      from: String(config.from ?? user ?? "schedule-alerter"),
      to: String(config.to),
      subject: "📅 Schedule Change Alert",
      text,
    });
    return { success: true, channel: "email" };
  } catch (err) {
    return { success: false, channel: "email", error: errMsg(err) };
  }
}

/** Deliver a message via the Telegram Bot API using telegraf. */
async function sendTelegram(
  text: string,
  config: Record<string, string | number | boolean>,
): Promise<DeliveryResult> {
  const botToken = String(config.botToken);
  const chatId = String(config.chatId);

  const bot = new Telegraf(botToken);
  try {
    await bot.telegram.sendMessage(chatId, text);
    return { success: true, channel: "telegram" };
  } catch (err) {
    return { success: false, channel: "telegram", error: errMsg(err) };
  }
}

/** Append a message to the local file log used by the `none` channel. */
async function sendFileLog(
  text: string,
  config: Record<string, string | number | boolean>,
): Promise<DeliveryResult> {
  const dir = config.file ? String(config.file) : process.cwd();
  const path = `${dir === "." ? "." : dir}/${FILE_LOG_NAME}`;
  try {
    mkdirSync(dir, { recursive: true });
    appendFileSync(path, `[${new Date().toISOString()}] ${text}\n`, "utf8");
    return { success: true, channel: "file" };
  } catch (err) {
    return { success: false, channel: "file", error: errMsg(err) };
  }
}

/**
 * Dispatch an alert to the configured fallback channel.
 * Returns a DeliveryResult; never throws.
 */
export async function sendFallback(
  text: string,
  fc: FallbackConfig,
): Promise<DeliveryResult> {
  switch (fc.type) {
    case "email":
      return sendEmail(text, fc.config);
    case "telegram":
      return sendTelegram(text, fc.config);
    case "none":
      return sendFileLog(text, fc.config);
    default:
      return { success: false, channel: "unknown", error: `Unknown fallback type: ${String(fc.type)}` };
  }
}

/** NotifierPort interface — satisfies the design's port contract. */
export interface FallbackPort {
  send(text: string, fc: FallbackConfig): Promise<DeliveryResult>;
}

export default sendFallback;
