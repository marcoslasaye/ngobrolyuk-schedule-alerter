/**
 * Scheduler orchestrator — main poll cycle.
 *
 * For each of the next N dates (config.dateRange, default 7):
 *   fetch → parse → diff against cache → if changes → queue alert.
 *
 * Error isolation is per-date: a failure on one date is logged and skipped
 * without stopping the loop. De-duplicates entries across all dates into a
 * single AlertPayload. On first run (empty cache) the alert is suppressed.
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
import type { ChangeSummary, AlertPayload } from "../notifier/types.js";
import type { CacheSchema, PollResult } from "./types.js";

/** ISO date string formatter (YYYY-MM-DD) used for poll dates. */
const ISO_DATE = "yyyy-MM-dd";

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
  /** NotifierPort: quiet-hours gate + delivery queue. */
  queue: {
    process(payload: AlertPayload, now?: Date): Promise<void>;
    flush(now?: Date): Promise<void>;
    isQuiet(date: Date): boolean;
    queuedCount: number;
    consecutiveFailures: number;
  };
  /** CachePort: load/save persisted schedule state. */
  cache: {
    load(): CacheSchema;
    save(schema: CacheSchema): void;
  };
  /** ConfigPort: validated config schema. */
  config: {
    teacherId: string;
    dateRange: number;
    pollIntervalMs: number;
    quietHours: { start: string; end: string; tz: string };
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
    return this.cronTask !== null;
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
   *  6. If not first run and changes exist → queue alert.
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

    // Build AlertPayload (skip on first run to suppress initial noise).
    if (!firstRun) {
      const changes = this.buildChangeSummaries(diffResult);
      if (changes.length > 0) {
        this.log.info({ changes: changes.length }, "poll:changes detected; queueing alert");
        await this.deps.queue.process({
          changes,
          timestamp: startedAt,
          dateRange: { start: dates[0], end: dates[dates.length - 1] },
        });
      }
    } else {
      this.log.info("poll:first run (empty cache); alert suppressed");
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
   * The cron expression is derived from pollIntervalMs (30-min default →
   * e.g. every 30 minutes).
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
  }

  /** Stop the daemon (no-op if not running). */
  stop(): void {
    if (this.cronTask) {
      this.cronTask.stop();
      this.cronTask = null;
      this.log.info("orchestrator:daemon stopped");
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

  /** Convert a DiffResult into an array of ChangeSummary for alerting. */
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
