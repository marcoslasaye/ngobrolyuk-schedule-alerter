/**
 * Fetcher HTTP client — retrying POST to the WP AJAX endpoint.
 *
 * Sends one POST per date to `/wp-admin/admin-ajax.php` with body
 * `action=fh_get_realtime_schedule&date=YYYY-MM-DD`. Retries transient
 * failures (network errors, timeouts, HTTP 5xx / 429) up to 3 attempts
 * total using exponential backoff (1s → 2s → 4s by default). The request
 * times out after 10s by default.
 *
 * Delays and timeout are injectable so unit tests run without real waits.
 */
import axios, { type AxiosInstance } from "axios";
import type { RawScheduleResponse, ScheduleEntry } from "./types.js";

/** Default base URL for the school site. */
export const DEFAULT_BASE_URL = "https://ngobrolyuk.com";
/** Default request timeout in milliseconds. */
export const DEFAULT_TIMEOUT_MS = 10000;
/** Default backoff delays (ms) between retry attempts (3 attempts total). */
export const DEFAULT_RETRY_DELAYS = [1000, 2000, 4000];
/** AJAX action the WordPress plugin expects. */
export const AJAX_ACTION = "fh_get_realtime_schedule";

/** Configuration for the HTTP client. */
export interface FetcherClientOptions {
  /** Base URL of the site (no trailing path). Default: https://ngobrolyuk.com */
  baseUrl?: string;
  /** Per-request timeout in ms. Default: 10000 */
  timeoutMs?: number;
  /** Delays between retry attempts. Default: [1000, 2000, 4000] */
  retryDelays?: number[];
}

/** Internal shared axios instance (per default config). */
function buildAxios(baseUrl: string, timeoutMs: number): AxiosInstance {
  return axios.create({
    baseURL: baseUrl,
    timeout: timeoutMs,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
}

/**
 * Sleep for `ms` milliseconds. Injectable-free; tests pass tiny delays.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch the raw schedule HTML for a single date.
 *
 * POSTs to `/wp-admin/admin-ajax.php` and returns a RawScheduleResponse.
 * Retries on transient failures with exponential backoff; throws after
 * exhausting all retry attempts (typically after the final non-2xx or an
 * unrecoverable error).
 *
 * A 2xx response is always accepted. Non-2xx responses and network/timeout
 * errors are retried. This mirrors the design's "fail the date, continue
 * others" error strategy (throw so the caller can skip the date).
 */
export async function fetchSchedule(
  date: string,
  options: FetcherClientOptions = {},
): Promise<RawScheduleResponse> {
  const {
    baseUrl = DEFAULT_BASE_URL,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retryDelays = DEFAULT_RETRY_DELAYS,
  } = options;

  const client = buildAxios(baseUrl, timeoutMs);

  const url = "/wp-admin/admin-ajax.php";
  const body = `action=${AJAX_ACTION}&date=${encodeURIComponent(date)}`;

  let lastError: unknown;

  for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
    try {
      const res = await client.post(url, body);
      // Treat any 2xx as success.
      return {
        status: res.status,
        html: typeof res.data === "string" ? res.data : JSON.stringify(res.data),
        date,
      };
    } catch (err) {
      lastError = err;
      const retryableError = isRetryable(err);
      const isLastAttempt = attempt === retryDelays.length;
      if (!retryableError || isLastAttempt) {
        throw err;
      }
      // Wait before the next attempt (skip wait on the final iteration).
      await sleep(retryDelays[attempt]);
    }
  }

  throw lastError;
}

/**
 * True when the error is a network error, timeout, or an HTTP status that
 * is worth retrying (429 or any 5xx). Client errors (4xx except 429) are
 * not retried.
 */
function isRetryable(err: unknown): boolean {
  if (axios.isAxiosError(err)) {
    const status = err.response?.status;
    if (typeof status === "number") {
      return status === 429 || status >= 500;
    }
    // No status => network error or timeout (code ECONNABORTED / ETIMEDOUT).
    return true;
  }
  return true;
}

/**
 * FetcherPort interface — satisfies the design's port contract.
 *
 * The concrete composition (HTTP fetch + HTML parse) is wired by the
 * orchestrator, which calls `fetchSchedule` then `parseSchedule`.
 * This type describes the full contract from the caller's perspective.
 */
export interface FetcherPort {
  fetch(date: string): Promise<ScheduleEntry[]>;
}
