/**
 * Scheduler orchestrator — main poll cycle.
 *
 * For each of the next N dates (config.dateRange, default 7):
 *   fetch → parse → diff against cache → if changes → route per-user alerts.
 *
 * Error isolation is per-date: a failure on one date is logged and skipped
 * without stopping the loop. De-duplicates entries across all dates into a
 * single AlertPayload. On first run (empty cache) the alert is suppressed.
 *
 * Phase 4 — per-user change alerts: after the diff, each registered bot
 * user receives their OWN alert (on their OWN chat_id) but ONLY when a
 * change affects a class dated TODAY or TOMORROW (in the user's timezone)
 * for the tutor they registered with. Changes on day+2 … or for other
 * tutors are logged only, never sent. With no registered users the cycle
 * logs and skips — there is no legacy broadcast fallback (a missing users
 * port logs a warning instead).
 *
 * Logs are PII-free: per-cycle dispatch log reports aggregate counts only
 * (`recipients`, `alerts`), never chat ids or tutor names.
 *
 * Supports two modes:
 *   - `pollOnce()`  : single cycle (run-once / GitHub Actions)
 *   - `start()`     : daemon mode with node-cron at the configured interval
 */
import { addDays, format } from "date-fns";
import cron, { type ScheduledTask } from "node-cron";
import pino from "pino";
import type { ScheduleEntry } from "../fetcher/types.js";
import type { DiffResult } from "../differ/engine.js";
import type { ChangeSummary, AlertPayload, DeliveryResult } from "../notifier/types.js";
import { addDays as addDaysStr, todayDate, DEFAULT_USER_TZ } from "../notifier/bot.js";
import type { UserRecord } from "../registry/userStore.js";
import type { CacheSchema, PollResult } from "./types.js";

/** ISO date string formatter (YYYY-MM-DD) used for poll dates. */
const ISO_DATE = "yyyy-MM-dd";

/** Normalize a tutor name for comparison (trim + case-insensitive). */
function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

/** Dependency container wired by the caller (test or CLI). */
export interface OrchestratorDeps {
  /** FetcherPort: fetch + parse a single date's schedule. */
  fetcher: {
    fetch(date: string): Promise<ScheduleEntry[]>;
  };
  /** DifferPort: compare cached vs current entries. */
  differ: {
    diff(old: ScheduleEntry[], current: ScheduleEntry[]): DiffResult;
  };
  /** NotifierPort: quiet-hours gate + delivery queue (per-user recipients). */
  queue: {
    process(payload: AlertPayload, now?: Date): Promise<void>;
    flush(now?: Date): Promise<void>;
    isQuiet(date: Date): boolean;
    queuedCount: number;
    consecutiveFailures: number;
  };
  /** UserRegistryPort: registered bot users for per-user alert routing. */
  users?: {
    /** All registered users (chatId → tutorName + tz). Empty = no alerts. */
    all(): Promise<UserRecord[]>;
  };
  /** CachePort: load/save persisted schedule state. */
  cache: {
    load(): CacheSchema;
    save(schema: CacheSchema): void;
  };
  /** SummarySenderPort: sends today's schedule digest to the configured channel. */
  summary: {
    sendToday(): Promise<DeliveryResult>;
  };
  /** Optional Telegram bot listener for interactive commands (e.g. /today). */
  bot?: {
    start(): Promise<void>;
    stop(): Promise<void>;
  };
  /** ConfigPort: validated config schema. */
  config: {
    teacherId: string;
    dateRange: number;
    pollIntervalMs: number;
    quietHours: { start: string; end: string; tz: string };
    dailySummary: { time: string; tz: string; enabled: boolean };
    whatsapp: { provider: "callmebot"; apiKey: string; phone: string };
    fallback: { type: "email" | "telegram" | "none"; config: Record<string, string | number | boolean> };
    cachePath: string;
  };
}

/** Summary result of a single poll cycle. */
export interface CycleResult {
  /** Number of dates polled successfully this cycle. */
  datesPolled: number;
  /** Number of dates that errored this cycle. */
  errors: number;
  /** Total entries fetched across all dates. */
  totalEntries: number;
  /** True when this run was the first (cache empty) — alert suppressed. */
  firstRun: boolean;
  /** ISO-8601 UTC start timestamp. */
  startedAt: string;
  /** ISO-8601 UTC end timestamp. */
  finishedAt: string;
}

/**
 * Scheduler orchestrator class. Holds its dependencies and exposes
 * `pollOnce()` and `start()`.
 */
export class ScheduleOrchestrator {
  private readonly deps: OrchestratorDeps;
  private readonly log: pino.Logger;
  private cronTask: ScheduledTask | null = null;
  private dailyCronTask: ScheduledTask | null = null;

  constructor(deps: OrchestratorDeps, logger?: pino.Logger) {
    this.deps = deps;
    this.log =
      logger ??
      pino({
        // Level + redaction for secrets; quiet for non-PRODUCTION.
        level: process.env["NODE_ENV"] === "test" ? "silent" : "info",
      });
  }

  /** True when the orchestrator daemon is running. */
  get running(): boolean {
    return this.cronTask !== null || this.dailyCronTask !== null;
  }

  /**
   * Execute a single full poll cycle.
   *
   * Steps:
   *  1. Load cached state.
   *  2. Compute the next `dateRange` dates starting today.
   *  3. For each date: fetch → parse (wrap in try/catch per date).
   *  4. Concatenate all successfully parsed entries.
   *  5. Diff combined current vs cached.
   *  6. If not first run and changes exist → route per-user alerts
   *     (TODAY/TOMORROW scope + tutor match, one alert per user chat).
   *  7. Save the combined entries back to cache.
   */
  async pollOnce(now: Date = new Date()): Promise<CycleResult> {
    const startedAt = now.toISOString();
    const results: PollResult[] = [];
    const cached = this.deps.cache.load();

    // Compute the list of dates to poll (today … today+dateRange-1).
    const dates: string[] = [];
    for (let i = 0; i < this.deps.config.dateRange; i += 1) {
      dates.push(format(addDays(now, i), ISO_DATE));
    }

    // Fetch + parse each date, isolating errors per date.
    const currentEntries: ScheduleEntry[] = [];
    let errors = 0;
    for (const date of dates) {
      try {
        this.log.info({ date }, "poll:fetch");
        const entries = await this.deps.fetcher.fetch(date);
        currentEntries.push(...entries);
        results.push({ date, entries, changed: entries.length, error: null });
      } catch (err) {
        errors += 1;
        this.log.error({ date, err: String(err) }, "poll:error date failed; continuing");
        results.push({ date, entries: [], changed: 0, error: String(err) });
      }
    }

    // Diff combined current vs cached.
    const diffResult = this.deps.differ.diff(cached.entries, currentEntries);
    const firstRun = diffResult.firstRun || cached.entries.length === 0;

    // Build per-user alerts (skip on first run to suppress initial noise).
    // Always call queue.process() so wake-flush runs every cycle (even with no new changes).
    const changes = this.buildChangeSummaries(diffResult);
    if (firstRun) {
      this.log.info("poll:first run (empty cache); alert suppressed");
      // Still flush any pending queue on first run (should be empty, but safe).
      await this.deps.queue.process({ changes: [], timestamp: startedAt, dateRange: { start: dates[0], end: dates[dates.length - 1] } }, now);
    } else if (changes.length === 0) {
      // No changes this cycle — nothing to route, but keep the flush cycle alive.
      await this.deps.queue.process({ changes: [], timestamp: startedAt, dateRange: { start: dates[0], end: dates[dates.length - 1] } }, now);
    } else {
      this.log.info({ changes: changes.length }, "poll:changes detected; routing per-user alerts");
      await this.dispatchPerUserAlerts(changes, startedAt, dates, now);
    }

    // Persist the current combined state.
    const schema: CacheSchema = {
      lastFetch: startedAt,
      entries: currentEntries,
    };
    this.deps.cache.save(schema);
    this.log.info(
      { dates: dates.length, entries: currentEntries.length, errors },
      "poll:cycle complete",
    );

    void results;
    return {
      datesPolled: dates.length,
      errors,
      totalEntries: currentEntries.length,
      firstRun,
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  }

  /**
   * Start the daemon: run one immediate cycle, then schedule a cron job at
   * the configured poll interval. Returns immediately after scheduling.
   *
   * The cron expression is derived from pollIntervalMs (5-min default →
   * e.g. every 5 minutes).
   */
  start(immediate = true): void {
    if (this.cronTask) {
      this.log.warn("orchestrator:already running; start() ignored");
      return;
    }

    // Optional immediate run for responsiveness at boot.
    if (immediate) {
      void this.runSafely();
    }

    const intervalMs = this.deps.config.pollIntervalMs;
    const cronExpr = intervalToCron(intervalMs);
    this.cronTask = cron.schedule(cronExpr, () => {
      void this.runSafely();
    });
    this.log.info({ cron: cronExpr, intervalMs }, "orchestrator:daemon started");

    // Daily schedule summary at the configured time in the configured timezone.
    const daily = this.deps.config.dailySummary;
    if (daily.enabled && daily.time) {
      const [hour, minute] = daily.time.split(":");
      const dailyExpr = `${minute} ${hour} * * *`;
      this.dailyCronTask = cron.schedule(dailyExpr, () => {
        void this.runDailySummarySafely();
      }, { timezone: daily.tz });
      this.log.info({ cron: dailyExpr, tz: daily.tz }, "orchestrator:daily summary scheduled");
    }

    // Optional Telegram bot listener for interactive commands (e.g. /today).
    if (this.deps.bot) {
      void this.deps.bot.start().then(() => {
        this.log.info("orchestrator:telegram bot started");
      }).catch((err) => {
        this.log.error(
          { err: String(err) },
          "orchestrator:telegram bot failed to start; continuing without it",
        );
      });
    }
  }

  /** Stop the daemon (no-op if not running). */
  stop(): void {
    if (this.cronTask) {
      this.cronTask.stop();
      this.cronTask = null;
      this.log.info("orchestrator:daemon stopped");
    }
    if (this.dailyCronTask) {
      this.dailyCronTask.stop();
      this.dailyCronTask = null;
    }
    // Stop the optional Telegram bot listener.
    if (this.deps.bot) {
      void this.deps.bot.stop();
    }
  }

  /** Run one cycle, catching every error so the daemon never dies. */
  private async runSafely(): Promise<void> {
    try {
      await this.pollOnce();
    } catch (err) {
      this.log.error({ err: String(err) }, "orchestrator:cycle failed; continuing");
    }
  }

  /** Send the daily summary, catching errors so the daemon never dies. */
  private async runDailySummarySafely(): Promise<void> {
    try {
      const result = await this.deps.summary.sendToday();
      this.log.info({ channel: result.channel, success: result.success }, "orchestrator:daily summary sent");
    } catch (err) {
      this.log.error({ err: String(err) }, "orchestrator:daily summary failed; continuing");
    }
  }

  /**
   * Route detected changes to the registered users, one combined alert per
   * user on their own chat_id.
   *
   * A user is alerted only for changes whose class date is TODAY or
   * TOMORROW in the USER's timezone (same resolution as the /today and
   * /tomorrow commands) AND whose tutor matches the user's registered
   * tutor (case-insensitive). A user missing/invalid tz defaults to
   * `DEFAULT_USER_TZ` (same default as the /today command) instead of
   * throwing. Everything else (day+2 …, other tutors, unregistered tutors)
   * is logged only. With no registered users the cycle logs and skips —
   * no legacy broadcast fallback; a missing users port logs a warning.
   *
   * Logs are PII-free: only aggregate counts (`recipients`, `alerts`) are
   * reported per cycle — never chat ids or tutor names.
   */
  private async dispatchPerUserAlerts(
    changes: ChangeSummary[],
    startedAt: string,
    dates: string[],
    now: Date,
  ): Promise<void> {
    const users = this.deps.users ? await this.deps.users.all() : [];
    if (users.length === 0) {
      if (this.deps.users) {
        this.log.info("poll:no registered users; skipping alerts (changes logged only)");
      } else {
        this.log.warn("orchestrator:per-user alerting disabled (users port not wired)");
      }
      // Keep the wake-flush convention alive (empty payload is a no-op on delivery).
      await this.deps.queue.process(
        { changes: [], timestamp: startedAt, dateRange: { start: dates[0], end: dates[dates.length - 1] } },
        now,
      );
      return;
    }

    // Aggregate counters — the only per-cycle dispatch log (PII-free).
    let recipients = 0;
    let alerts = 0;
    for (const user of users) {
      const tz = user.tz?.trim() || DEFAULT_USER_TZ;
      const today = todayDate(tz, now);
      const tomorrow = addDaysStr(today, 1);
      const scope = new Set([today, tomorrow]);
      const mine = changes.filter(
        (c) =>
          scope.has(c.class.date) &&
          normalizeName(c.class.tutor) === normalizeName(user.tutorName),
      );
      if (mine.length === 0) {
        continue;
      }
      recipients += 1;
      alerts += mine.length;
      await this.deps.queue.process(
        {
          changes: mine,
          timestamp: startedAt,
          dateRange: { start: dates[0], end: dates[dates.length - 1] },
          recipientChatId: user.chatId,
        },
        now,
      );
    }
    if (recipients > 0) {
      this.log.info({ recipients, alerts }, "poll:per-user alerts queued");
    }
  }

  /**
   * Convert a DiffResult into an array of ChangeSummary for alerting.
   * Every summary's `class` carries the original entry, so `date` and
   * `tutor` flow through from the differ for per-user routing.
   */
  private buildChangeSummaries(diff: DiffResult): ChangeSummary[] {
    const summaries: ChangeSummary[] = [];
    for (const e of diff.diff.added) {
      summaries.push({
        type: "added",
        class: e,
        detail: `New class: ${e.student} on ${e.date} at ${e.time}`,
      });
    }
    for (const r of diff.diff.removed) {
      summaries.push({
        type: "removed",
        class: r,
        detail: `Removed class: ${r.student} on ${r.date} at ${r.time}`,
      });
    }
    for (const m of diff.diff.modified) {
      summaries.push({
        type: "modified",
        class: m.new,
        detail: `Class modified: ${m.new.student} on ${m.new.date} at ${m.new.time}`,
      });
    }
    return summaries;
  }
}

/**
 * Convert a poll interval (ms) into a node-cron expression.
 *
 * Only supports intervals that divide an hour evenly and are <= 60 min
 * (the schedule-alerter runs every 30 min by default). Falls back to
 * every-hour (`0 * * * *`) for unrecognized values.
 */
function intervalToCron(intervalMs: number): string {
  const minutes = Math.round(intervalMs / 60000);
  if (minutes >= 60 || 60 % minutes !== 0) {
    return "0 * * * *"; // hourly fallback
  }
  if (minutes === 1) {
    return "* * * * *";
  }
  return `*/${minutes} * * * *`;
}

/**
 * Create an orchestrator with the given dependencies.
 * Convenience factory matching the design's composition style.
 */
export function createOrchestrator(
  deps: OrchestratorDeps,
  logger?: pino.Logger,
): ScheduleOrchestrator {
  return new ScheduleOrchestrator(deps, logger);
}

export default ScheduleOrchestrator;

// Re-export any type used by the CLI so callers import from a single place.
export type { PollResult };
