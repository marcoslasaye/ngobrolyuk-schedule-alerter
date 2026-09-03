/**
 * Notifier quiet-hours queue.
 *
 * Gates alert delivery by quiet hours in Bali time (default 22:00–06:00
 * Asia/Makassar). Changes during quiet hours are queued and flushed as a
 * single message when the window opens. Per-cycle dedup keeps at most one
 * change per unique hash. Tracks consecutive WhatsApp failures and routes
 * to the fallback channel after 3 consecutive failures (fallback recovery
 * resets the counter).
 */
import { toZonedTime, format } from "date-fns-tz";
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
  /** Primary delivery channel (WhatsApp). */
  onSend: (text: string) => Promise<DeliveryResult>;
  /** Fallback delivery channel (email/telegram/file). */
  onFallback: (text: string) => Promise<DeliveryResult>;
}

/** Number of consecutive WhatsApp failures before switching to fallback. */
export const FALLBACK_THRESHOLD = 3;

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
  private pending: ChangeSummary[] = [];
  private seenHashes = new Set<string>();
  private failures = 0;

  constructor(opts: QueueOptions) {
    this.quiet = { start: opts.start, end: opts.end, tz: opts.tz };
    this.onSend = opts.onSend;
    this.onFallback = opts.onFallback;
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
   * then either stays silent (quiet hours) or flushes immediately.
   */
  async process(payload: AlertPayload, now: Date = new Date()): Promise<void> {
    if (payload.changes.length === 0) {
      return;
    }

    // Per-cycle dedup: at most one change per unique hash.
    this.seenHashes = new Set<string>();
    const deduped: ChangeSummary[] = [];
    for (const c of payload.changes) {
      if (!this.seenHashes.has(c.class.hash)) {
        this.seenHashes.add(c.class.hash);
        deduped.push(c);
      }
    }
    this.pending.push(...deduped);

    if (this.isQuiet(now)) {
      return; // stays queued; delivered when the window opens
    }
    await this.flush(now);
  }

  /** Deliver all queued changes as a single message right now. */
  async flush(now: Date = new Date()): Promise<void> {
    if (this.pending.length === 0) {
      return;
    }

    const text = this.buildText(now);
    const result = await this.onSend(text);

    if (result.success) {
      this.failures = 0;
      this.pending = [];
      return;
    }

    this.failures += 1;
    if (this.failures >= FALLBACK_THRESHOLD) {
      const fallbackResult = await this.onFallback(text);
      if (fallbackResult.success) {
        this.failures = 0;
        this.pending = [];
      }
      // Otherwise keep the pending changes for retry next cycle.
    }
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

  /** Build a single aggregated message from the pending deduplicated changes. */
  private buildText(now: Date): string {
    const seen = new Set<string>();
    const aggregated: ChangeSummary[] = [];
    for (const c of this.pending) {
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
