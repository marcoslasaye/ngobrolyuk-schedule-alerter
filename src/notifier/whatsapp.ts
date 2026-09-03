/**
 * Notifier WhatsApp client — CallMeBot delivery.
 *
 * Sends one WhatsApp text per poll cycle via the CallMeBot API using an HTTP
 * GET with `phone`, `apikey`, and `text` query parameters. Retries transient
 * failures (HTTP 429 / 5xx / network) up to 2 times with a 5-second delay
 * (3 attempts total). Returns a DeliveryResult; never throws.
 */
import axios, { type AxiosInstance } from "axios";
import type { DeliveryResult } from "./types.js";

/** CallMeBot API base URL. */
export const WHATSAPP_BASE_URL = "https://api.callmebot.com";
/** CallMeBot WhatsApp endpoint path. */
export const WHATSAPP_PATH = "/whatsapp.php";
/** Default per-request timeout in ms. */
export const WHATSAPP_TIMEOUT_MS = 10000;
/** Default delays (ms) between the 2 retries after the initial attempt. */
export const WHATSAPP_DEFAULT_RETRY_DELAYS = [5000, 5000];

/** Receiver config required to send a message. */
export interface WhatsAppConfig {
  /** Receiver phone number (E.164-ish, as expected by CallMeBot). */
  phone: string;
  /** CallMeBot API key. */
  apiKey: string;
}

/** Injectable options for the client (used by tests to avoid real waits). */
export interface WhatsAppClientOptions {
  /** Base URL override. Default: WHATSAPP_BASE_URL. */
  baseUrl?: string;
  /** Endpoint path override. Default: WHATSAPP_PATH. */
  path?: string;
  /** Per-request timeout in ms. Default: WHATSAPP_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Delays between retries. Default: WHATSAPP_DEFAULT_RETRY_DELAYS. */
  retryDelays?: number[];
}

function buildClient(baseUrl: string, timeoutMs: number): AxiosInstance {
  return axios.create({ baseURL: baseUrl, timeout: timeoutMs });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * True when an error is worth retrying: network/timeout errors (no status)
 * or HTTP 429 / 5xx. Client errors (other 4xx) are not retried.
 */
function isRetryable(err: unknown): boolean {
  if (axios.isAxiosError(err)) {
    const status = err.response?.status;
    if (typeof status === "number") {
      return status === 429 || status >= 500;
    }
    return true;
  }
  return true;
}

/**
 * Send a WhatsApp summary text via CallMeBot.
 *
 * Returns a DeliveryResult. Never throws — transient failures are retried,
 * and if all attempts fail a failed result is returned.
 */
export async function sendWhatsApp(
  text: string,
  config: WhatsAppConfig,
  options: WhatsAppClientOptions = {},
): Promise<DeliveryResult> {
  const {
    baseUrl = WHATSAPP_BASE_URL,
    path = WHATSAPP_PATH,
    timeoutMs = WHATSAPP_TIMEOUT_MS,
    retryDelays = WHATSAPP_DEFAULT_RETRY_DELAYS,
  } = options;

  const client = buildClient(baseUrl, timeoutMs);
  let lastError: unknown;

  for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
    try {
      await client.get(path, {
        params: {
          phone: config.phone,
          apikey: config.apiKey,
          text,
        },
      });
      return { success: true, channel: "whatsapp" };
    } catch (err) {
      lastError = err;
      const isLastAttempt = attempt === retryDelays.length;
      if (!isRetryable(err) || isLastAttempt) {
        break;
      }
      await sleep(retryDelays[attempt]);
    }
  }

  return {
    success: false,
    channel: "whatsapp",
    error: describeError(lastError),
  };
}

/** Build a readable error string from the last failure. */
function describeError(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const status = err.response?.status;
    if (typeof status === "number") {
      return `HTTP ${status}`;
    }
    return err.code ?? err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

/** WhatsAppPort interface — satisfies the design's notifier port contract. */
export interface WhatsAppPort {
  send(text: string, config: WhatsAppConfig): Promise<DeliveryResult>;
}

export default sendWhatsApp;
