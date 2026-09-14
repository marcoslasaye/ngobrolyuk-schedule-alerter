/**
 * Notifier quiet-hours queue.
 *
 * Gates alert delivery by quiet hours in Bali time (default 22:00–06:00
 * Asia/Makassar). Changes during quiet hours are queued and flushed as a
 * single message when the window opens. Per-cycle dedup keeps at most one
 * change per unique hash. Tracks consecutive WhatsApp failures and routes
 * to the fallback channel after 3 consecutive failures (fallback recovery
 * resets the counter).
 *
 * Per-user alerts (Phase 4): payloads carrying `recipientChatId` are
 * delivered to that chat via `onSendToUser`. Pending per-user changes are
 * grouped by recipient on flush so each user receives ONE combined message
 * on their own chat. A per-user payload never falls through to the legacy
 * single-recipient path: when `onSendToUser` is not wired the group is
 * skipped with an error logged. The legacy `onSend` path runs ONLY for
 * payloads without a recipient.
 */
import { toZonedTime, format } from "date-fns-tz";
import pino from "pino";
import { formatAlert } from "./formatter.js";
import type { AlertPayload, ChangeSummary, DeliveryResult } from "./types.js";

/** Quiet hours window expressed as "HH:mm" strings and a TZ identifier. */
export interface QuietHoursConfig {
  /** Start of the quiet window, e.g. "22:00". */
  start: string;
  /** End of the quiet window, e.g. "06:00". */
  end: string;
  /** IANA timezone, e.g. "Asia/Makassar" (Bali). */
  tz: string;
}

/** Delivery callbacks injected into the queue (real clients in production, mocks in tests). */
export interface QueueOptions extends QuietHoursConfig {
  /** Primary delivery channel (WhatsApp — legacy single-recipient). */
  onSend: (text: string) => Promise<DeliveryResult>;
  /** Fallback delivery channel (email/telegram/file). */
  onFallback: (text: string) => Promise<DeliveryResult>;
  /**
   * Per-user delivery channel: sends an alert text to a specific Telegram
   * chat_id. Alerts with `recipientChatId` use this. When it is NOT wired,
   * per-user alerts are skipped with an error logged — they never fall
   * through to the legacy `onSend` channel. `onSend` runs only for payloads
   * without a recipient.
   */
  onSendToUser?: (text: string, chatId: string) => Promise<DeliveryResult>;
  /** Pino-compatible logger for queue diagnostics (defaults to silent in tests). */
  logger?: QueueLogger;
}

/** Minimal logger surface the queue needs (pino-compatible). */
export interface QueueLogger {
  /** Log an error message (single-arg string form). */
  error(msg: string): void;
}

/** Number of consecutive WhatsApp failures before switching to fallback. */
export const FALLBACK_THRESHOLD = 3;

/** One queued change plus the recipient it is addressed to (undefined = legacy). */
interface PendingItem {
  /** Telegram chat id for per-user alerts; undefined for the legacy recipient. */
  recipient?: string;
  change: ChangeSummary;
}

/** Convert an "HH:mm" string to minutes-since-midnight. */
function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** Map the queue's change-pending state. */
export class AlertQueue {
  private readonly quiet: QuietHoursConfig;
  private readonly onSend: (text: string) => Promise<DeliveryResult>;
  private readonly onFallback: (text: string) => Promise<DeliveryResult>;
  private readonly onSendToUser?: (text: string, chatId: string) => Promise<DeliveryResult>;
  private readonly log: QueueLogger;
  private pending: PendingItem[] = [];
  private seenHashes = new Set<string>();
  private failures = 0;

  constructor(opts: QueueOptions) {
    this.quiet = { start: opts.start, end: opts.end, tz: opts.tz };
    this.onSend = opts.onSend;
    this.onFallback = opts.onFallback;
    this.onSendToUser = opts.onSendToUser;
    this.log =
      opts.logger ??
      pino({ level: process.env["NODE_ENV"] === "test" ? "silent" : "info" });
  }

  /** Number of changes currently queued (awaiting quiet-window flush). */
  get queuedCount(): number {
    return this.pending.length;
  }

  /** Consecutive WhatsApp delivery failures (persists across cycles). */
  get consecutiveFailures(): number {
    return this.failures;
  }

  /**
   * Process one poll cycle's alert payload.
   *
   * Dedups changes per cycle (at most one per hash), appends to the queue,
   * then either stays silent (quiet hours) or flushes immediately. A change
   * is kept together with its recipient, so per-user alerts never leak into
   * another user's message.
   */
  async process(payload: AlertPayload, now: Date = new Date()): Promise<void> {
    if (payload.changes.length === 0) {
      return;
    }

    // Per-cycle dedup: at most one change per unique hash.
    this.seenHashes = new Set<string>();
    for (const c of payload.changes) {
      if (!this.seenHashes.has(c.class.hash)) {
        this.seenHashes.add(c.class.hash);
        this.pending.push({ recipient: payload.recipientChatId, change: c });
      }
    }

    if (this.isQuiet(now)) {
      return; // stays queued; delivered when the window opens
    }
    await this.flush(now);
  }

  /** Deliver all queued changes right now, one combined message per recipient. */
  async flush(now: Date = new Date()): Promise<void> {
    if (this.pending.length === 0) {
      return;
    }

    // Group pending changes by recipient so each user gets their own message.
    const groups = new Map<string | undefined, ChangeSummary[]>();
    for (const item of this.pending) {
      const list = groups.get(item.recipient) ?? [];
      list.push(item.change);
      groups.set(item.recipient, list);
    }

    // Undelivered items stay pending for the retry next cycle.
    const remaining: PendingItem[] = [];
    for (const [recipient, changes] of groups) {
      const text = this.buildText(changes, now);
      let result: DeliveryResult;

      if (recipient !== undefined) {
        // Per-user alert: MUST go to the recipient's own chat. If the
        // per-user channel is not wired, skip the group — never deliver
        // another user's alert to the legacy chat.
        if (!this.onSendToUser) {
          this.log.error(
            `queue:onSendToUser not wired; skipping ${changes.length} alerts for recipient`,
          );
          continue;
        }
        result = await this.onSendToUser(text, recipient);
      } else {
        // Legacy path: only payloads without a recipient use the primary channel.
        result = await this.onSend(text);
      }

      if (result.success) {
        this.failures = 0;
        continue;
      }

      this.failures += 1;
      if (this.failures >= FALLBACK_THRESHOLD) {
        const fallbackResult = await this.onFallback(text);
        if (fallbackResult.success) {
          this.failures = 0;
          continue;
        }
        // Otherwise keep this recipient's changes for retry next cycle.
      }
      for (const change of changes) {
        remaining.push({ recipient, change });
      }
    }
    this.pending = remaining;
  }

  /** Whether `date` falls inside the configured quiet window (in `tz`). */
  isQuiet(date: Date): boolean {
    const bali = format(toZonedTime(date, this.quiet.tz), "HH:mm");
    const t = toMinutes(bali);
    const s = toMinutes(this.quiet.start);
    const e = toMinutes(this.quiet.end);
    // A window that crosses midnight (start > end) is "in" when t >= start
    // OR t < end; a same-day window is "in" when start <= t <= end.
    return s <= e ? t >= s && t <= e : t >= s || t < e;
  }

  /** Build a single aggregated message from the given deduplicated changes. */
  private buildText(changes: ChangeSummary[], now: Date): string {
    const seen = new Set<string>();
    const aggregated: ChangeSummary[] = [];
    for (const c of changes) {
      if (!seen.has(c.class.hash)) {
        seen.add(c.class.hash);
        aggregated.push(c);
      }
    }
    return formatAlert({
      changes: aggregated,
      timestamp: now.toISOString(),
      dateRange: { start: "", end: "" },
    });
  }
}

export default AlertQueue;
