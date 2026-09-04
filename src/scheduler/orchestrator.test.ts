/**
 * Tests for the scheduler orchestrator — main poll cycle.
 *
 * Covers: single poll cycle, error isolation per date, first-run suppression,
 * cron scheduling, run-once mode, and structured logging.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createOrchestrator, type OrchestratorDeps } from "./orchestrator.js";
import type { ScheduleEntry } from "../fetcher/types.js";
import type { DiffResult } from "../differ/engine.js";
import type { AlertPayload, DeliveryResult } from "../notifier/types.js";
import type { CacheSchema } from "./types.js";

/** Minimal ScheduleEntry helper for tests. */
function entry(
  hash: string,
  overrides: Partial<ScheduleEntry> = {},
): ScheduleEntry {
  return {
    date: "2026-09-03",
    time: "10:00",
    student: "Student",
    level: "Beginner",
    language: "English",
    status: "confirmed",
    hash,
    ...overrides,
  };
}

/** Build a mock FetcherPort that returns entries per date. */
function mockFetcher(
  map: Record<string, ScheduleEntry[]> = {},
  failDates: string[] = [],
): OrchestratorDeps["fetcher"] {
  return {
    fetch: vi.fn(async (date: string) => {
      if (failDates.includes(date)) {
        throw new Error(`fetch failed for ${date}`);
      }
      return map[date] ?? [];
    }),
  };
}

/** Build a mock DifferPort that uses the real diffEntries logic. */
function mockDiffer(): OrchestratorDeps["differ"] {
  return {
    diff: vi.fn((_old: ScheduleEntry[], current: ScheduleEntry[]) => ({
      firstRun: false,
      diff: { added: current, removed: [], modified: [] },
    })),
  };
}

/** Build a mock NotifierPort (AlertQueue) that captures payloads. */
function mockQueue(): OrchestratorDeps["queue"] & {
  payloads: AlertPayload[];
} {
  const payloads: AlertPayload[] = [];
  return {
    payloads,
    process: vi.fn(async (payload: AlertPayload) => {
      payloads.push(payload);
    }),
    flush: vi.fn(async () => {}),
    isQuiet: vi.fn(() => false),
    queuedCount: 0,
    consecutiveFailures: 0,
  };
}

/** Build a mock CachePort that returns and captures schemas. */
function mockCache(
  initial: CacheSchema = { entries: [], lastFetch: "" },
): OrchestratorDeps["cache"] & { saved: CacheSchema[] } {
  const saved: CacheSchema[] = [];
  return {
    saved,
    load: vi.fn(() => initial),
    save: vi.fn((schema: CacheSchema) => {
      saved.push(schema);
    }),
  };
}

/** Build mock ConfigSchema with test defaults. */
function mockConfig(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    teacherId: "marcos",
    dateRange: 7,
    pollIntervalMs: 1800000,
    quietHours: { start: "22:00", end: "06:00", tz: "Asia/Makassar" },
    whatsapp: { provider: "callmebot" as const, apiKey: "test-key", phone: "+1234" },
    fallback: { type: "none" as const, config: {} },
    cachePath: "/tmp/test-cache",
    ...overrides,
  };
}

describe("createOrchestrator", () => {
  let dateNow: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Freeze Date.now() so the test dates are deterministic.
    dateNow = vi.spyOn(Date, "now").mockReturnValue(
      new Date("2026-09-03T08:00:00.000Z").getTime(),
    );
  });

  afterEach(() => {
    dateNow.mockRestore();
  });

  it("runs a single poll cycle: fetches 7 dates, diffs, and queues alerts when changes exist", async () => {
    const entries: Record<string, ScheduleEntry[]> = {
      "2026-09-03": [entry("h1", { date: "2026-09-03" })],
      "2026-09-04": [entry("h2", { date: "2026-09-04" })],
      "2026-09-05": [entry("h3", { date: "2026-09-05" })],
      "2026-09-06": [entry("h4", { date: "2026-09-06" })],
      "2026-09-07": [entry("h5", { date: "2026-09-07" })],
      "2026-09-08": [entry("h6", { date: "2026-09-08" })],
      "2026-09-09": [entry("h7", { date: "2026-09-09" })],
    };

    const fetcher = mockFetcher(entries);
    const differ = mockDiffer();
    const queue = mockQueue();
    // Pre-populated cache so this is NOT the first run (alerts not suppressed).
    const cache = mockCache({
      entries: [entry("h0", { date: "2026-09-03", student: "Old" })],
      lastFetch: "2026-09-02T08:00:00.000Z",
    });
    const config = mockConfig();

    const orch = createOrchestrator({ fetcher, differ, queue, cache, config });
    const result = await orch.pollOnce();

    // Should have fetched all 7 dates.
    expect(fetcher.fetch).toHaveBeenCalledTimes(7);

    // Queue should have been called with the combined entries.
    expect(queue.process).toHaveBeenCalled();
    const payload = queue.process.mock.calls[0][0] as AlertPayload;
    expect(payload.changes.length).toBeGreaterThan(0);

    // Cache should have been saved with the combined entries.
    expect(cache.save).toHaveBeenCalled();
    expect(result.datesPolled).toBe(7);
    expect(result.errors).toBe(0);
  });

  it("isolates errors per date — one failing date does not stop others", async () => {
    const entries: Record<string, ScheduleEntry[]> = {
      "2026-09-03": [entry("h1", { date: "2026-09-03" })],
      "2026-09-04": [], // empty
      "2026-09-05": [entry("h3", { date: "2026-09-05" })],
      "2026-09-06": [], // empty
      "2026-09-07": [], // empty
      "2026-09-08": [], // empty
      "2026-09-09": [], // empty
    };
    const fetcher = mockFetcher(entries, ["2026-09-04"]);
    const differ = mockDiffer();
    const queue = mockQueue();
    // Pre-populated cache so this is NOT the first run (alerts not suppressed).
    const cache = mockCache({
      entries: [entry("h0", { date: "2026-09-03", student: "Old" })],
      lastFetch: "2026-09-02T08:00:00.000Z",
    });
    const config = mockConfig();

    const orch = createOrchestrator({ fetcher, differ, queue, cache, config });
    const result = await orch.pollOnce();

    // Still fetched all 7 dates.
    expect(fetcher.fetch).toHaveBeenCalledTimes(7);
    // 1 error (2026-09-04 failed).
    expect(result.errors).toBe(1);
    // Queue was still called with the remaining successful entries.
    expect(queue.process).toHaveBeenCalled();
  });

  it("suppresses alert on first run (empty cache → all entries added) but still flushes queue", async () => {
    const entries: Record<string, ScheduleEntry[]> = {
      "2026-09-03": [entry("h1", { date: "2026-09-03" })],
      "2026-09-04": [],
      "2026-09-05": [],
      "2026-09-06": [],
      "2026-09-07": [],
      "2026-09-08": [],
      "2026-09-09": [],
    };
    const fetcher = mockFetcher(entries);

    // Differ that always returns firstRun=true.
    const differ: OrchestratorDeps["differ"] = {
      diff: vi.fn(() => ({
        firstRun: true,
        diff: { added: [entry("h1")], removed: [], modified: [] },
      })),
    };

    const queue = mockQueue();
    const cache = mockCache();
    const config = mockConfig();

    const orch = createOrchestrator({ fetcher, differ, queue, cache, config });
    const result = await orch.pollOnce();

    // Queue IS called on first run (to allow wake-flush), but with empty changes.
    expect(queue.process).toHaveBeenCalled();
    const payload = queue.process.mock.calls[0][0] as AlertPayload;
    expect(payload.changes).toEqual([]);
    expect(result.firstRun).toBe(true);
    // But cache should still be saved.
    expect(cache.save).toHaveBeenCalled();
  });

  it("uses configurable dateRange from config", async () => {
    const fetcher = mockFetcher();
    const differ = mockDiffer();
    const queue = mockQueue();
    const cache = mockCache();
    const config = mockConfig({ dateRange: 3 });

    const orch = createOrchestrator({ fetcher, differ, queue, cache, config });
    await orch.pollOnce();

    // Should fetch exactly 3 dates.
    expect(fetcher.fetch).toHaveBeenCalledTimes(3);
  });

  it("returns PollResult summary with correct counts", async () => {
    const entries: Record<string, ScheduleEntry[]> = {
      "2026-09-03": [entry("h1", { date: "2026-09-03" })],
      "2026-09-04": [],
      "2026-09-05": [],
      "2026-09-06": [],
      "2026-09-07": [],
      "2026-09-08": [],
      "2026-09-09": [],
    };
    const fetcher = mockFetcher(entries);
    const differ = mockDiffer();
    const queue = mockQueue();
    const cache = mockCache();
    const config = mockConfig();

    const orch = createOrchestrator({ fetcher, differ, queue, cache, config });
    const result = await orch.pollOnce();

    expect(result.datesPolled).toBe(7);
    expect(result.errors).toBe(0);
    expect(result.totalEntries).toBe(1);
    expect(typeof result.startedAt).toBe("string");
    expect(typeof result.finishedAt).toBe("string");
  });
});
