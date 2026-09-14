/**
 * Tests for the scheduler orchestrator — main poll cycle.
 *
 * Covers: single poll cycle, error isolation per date, first-run suppression,
 * cron scheduling, run-once mode, structured logging, and Phase 4 per-user
 * change alerts (TODAY/TOMORROW scope per user timezone + tutor match).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createOrchestrator, type OrchestratorDeps } from "./orchestrator.js";
import pino from "pino";
import type { ScheduleEntry } from "../fetcher/types.js";
import type { DiffResult } from "../differ/engine.js";
import type { AlertPayload, DeliveryResult } from "../notifier/types.js";
import type { UserRecord } from "../registry/userStore.js";
import type { CacheSchema } from "./types.js";

/** Minimal ScheduleEntry helper for tests (tutor defaults to Marcos Lopez). */
function entry(
  hash: string,
  overrides: Partial<ScheduleEntry> = {},
): ScheduleEntry {
  return {
    date: "2026-09-03",
    time: "10:00",
    tutor: "Marcos Lopez",
    student: "Student",
    level: "Beginner",
    language: "English",
    status: "confirmed",
    hash,
    ...overrides,
  };
}

/** Minimal registered-user helper for tests. */
function user(chatId: string, tutorName: string, tz = "Asia/Makassar"): UserRecord {
  return { chatId, tutorName, tz, registeredAt: "2026-09-01T00:00:00.000Z" };
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

/** Build a mock UserRegistryPort returning the given registered users. */
function mockUsers(users: UserRecord[] = []): OrchestratorDeps["users"] & {
  all: ReturnType<typeof vi.fn>;
} {
  return { all: vi.fn(async () => users) };
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

/** Build a mock SummarySenderPort that reports a successful Telegram send. */
function mockSummary(): OrchestratorDeps["summary"] {
  return {
    sendToday: vi.fn(async () => ({ success: true, channel: "telegram" })),
  };
}

/**
 * Capture orchestrator log lines (parsed pino JSON) for assertions.
 * Levels are numeric: 30 = info, 40 = warn, 50 = error.
 */
function captureLogger(): {
  log: pino.Logger;
  lines: Array<Record<string, unknown>>;
} {
  const lines: Array<Record<string, unknown>> = [];
  const stream = {
    write(line: string): boolean {
      lines.push(JSON.parse(line) as Record<string, unknown>);
      return true;
    },
  };
  return { log: pino({ level: "trace", base: undefined }, stream), lines };
}

/** Build mock ConfigSchema with test defaults. */
function mockConfig(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    teacherId: "marcos",
    dateRange: 7,
    pollIntervalMs: 1800000,
    quietHours: { start: "22:00", end: "06:00", tz: "Asia/Makassar" },
    dailySummary: { time: "07:00", tz: "Asia/Makassar", enabled: true },
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

  it("runs a single poll cycle: fetches 7 dates, diffs, and queues per-user alerts when changes exist", async () => {
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
    const summary = mockSummary();
    const users = mockUsers([user("u1", "Marcos Lopez")]);
    // Pre-populated cache so this is NOT the first run (alerts not suppressed).
    const cache = mockCache({
      entries: [entry("h0", { date: "2026-09-03", student: "Old" })],
      lastFetch: "2026-09-02T08:00:00.000Z",
    });
    const config = mockConfig();

    const orch = createOrchestrator({ fetcher, differ, queue, cache, summary, config, users });
    const frozenDate = new Date("2026-09-03T08:00:00.000Z");
    const result = await orch.pollOnce(frozenDate);

    // Should have fetched all 7 dates.
    expect(fetcher.fetch).toHaveBeenCalledTimes(7);

    // Queue should have been called with the changes, explicit per-user recipient.
    expect(queue.process).toHaveBeenCalled();
    const payload = queue.process.mock.calls[0][0] as AlertPayload;
    // Only TODAY (2026-09-03) + TOMORROW (2026-09-04) changes reach the user.
    expect(payload.changes).toHaveLength(2);
    expect(payload.changes.map((c) => c.class.hash).sort()).toEqual(["h1", "h2"]);
    expect(payload.recipientChatId).toBe("u1");

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
    const summary = mockSummary();
    const users = mockUsers([user("u1", "Marcos Lopez")]);
    // Pre-populated cache so this is NOT the first run (alerts not suppressed).
    const cache = mockCache({
      entries: [entry("h0", { date: "2026-09-03", student: "Old" })],
      lastFetch: "2026-09-02T08:00:00.000Z",
    });
    const config = mockConfig();

    const orch = createOrchestrator({ fetcher, differ, queue, cache, summary, config, users });
    // Pass frozen date so generated dates match mock keys.
    const frozenDate = new Date("2026-09-03T08:00:00.000Z");
    const result = await orch.pollOnce(frozenDate);

    // Still fetched all 7 dates.
    expect(fetcher.fetch).toHaveBeenCalledTimes(7);
    // 1 error (2026-09-04 failed).
    expect(result.errors).toBe(1);
    // Queue was still called, with only the in-scope change of the user's tutor.
    expect(queue.process).toHaveBeenCalled();
    const payload = queue.process.mock.calls[0][0] as AlertPayload;
    expect(payload.changes).toHaveLength(1);
    expect(payload.changes[0].class.hash).toBe("h1");
    expect(payload.recipientChatId).toBe("u1");
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
    const summary = mockSummary();
    const cache = mockCache();
    const config = mockConfig();

    const orch = createOrchestrator({ fetcher, differ, queue, cache, summary, config });
    const frozenDate = new Date("2026-09-03T08:00:00.000Z");
    const result = await orch.pollOnce(frozenDate);

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
    const summary = mockSummary();
    const cache = mockCache();
    const config = mockConfig({ dateRange: 3 });

    const orch = createOrchestrator({ fetcher, differ, queue, cache, summary, config });
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
    const summary = mockSummary();
    const cache = mockCache();
    const config = mockConfig();

    const orch = createOrchestrator({ fetcher, differ, queue, cache, summary, config });
    // Pass frozen date so generated dates match mock keys.
    const frozenDate = new Date("2026-09-03T08:00:00.000Z");
    const result = await orch.pollOnce(frozenDate);

    expect(result.datesPolled).toBe(7);
    expect(result.errors).toBe(0);
    expect(result.totalEntries).toBe(1);
    expect(typeof result.startedAt).toBe("string");
    expect(typeof result.finishedAt).toBe("string");
  });

  it("start() schedules the daily summary cron in the configured timezone", () => {
    const fetcher = mockFetcher();
    const differ = mockDiffer();
    const queue = mockQueue();
    const summary = mockSummary();
    const cache = mockCache();
    const config = mockConfig();

    const orch = createOrchestrator({ fetcher, differ, queue, cache, summary, config });
    orch.start(false);

    // Both the poll cron and the daily summary cron must be scheduled.
    expect(orch.running).toBe(true);
    // Summary port is wired into the orchestrator deps.
    expect(summary.sendToday).toBeDefined();

    orch.stop();
    expect(orch.running).toBe(false);
  });
});

describe("per-user change alerts (Phase 4)", () => {
  // All tests freeze the poll instant at 2026-09-03T08:00:00Z. In
  // Asia/Makassar (UTC+8) that is 16:00 on 2026-09-03, so "today" =
  // 2026-09-03 and "tomorrow" = 2026-09-04 — the same scope the /today
  // command resolves for the user's timezone.
  const FROZEN = new Date("2026-09-03T08:00:00.000Z");

  function runPoll(overrides: Partial<Record<string, unknown>> = {}) {
    const fetcher = mockFetcher(
      (overrides.entries as Record<string, ScheduleEntry[]>) ?? {},
    );
    const differ = mockDiffer();
    const queue = mockQueue();
    const summary = mockSummary();
    const users = mockUsers(
      (overrides.users as UserRecord[] | undefined) ?? [],
    );
    const cache = mockCache({
      entries: [entry("h0", { date: "2026-09-03", student: "Old" })],
      lastFetch: "2026-09-02T08:00:00.000Z",
    });
    const config = mockConfig();
    const orch = createOrchestrator(
      {
        fetcher,
        differ,
        queue,
        cache,
        summary,
        config,
        users: (overrides.noUsersPort as boolean | undefined)
          ? undefined
          : users,
      },
      overrides.logger as pino.Logger | undefined,
    );
    return { orch, queue, fetcher, cache };
  }

  it("does NOT alert for a change dated day+2 (scope is TODAY/TOMORROW only)", async () => {
    // Core Phase 4 rule: a change on 2026-09-05 (day+2) must not alert.
    const { orch, queue } = runPoll({
      users: [user("u1", "Marcos Lopez")],
      entries: {
        "2026-09-05": [entry("h5", { date: "2026-09-05" })],
      },
    });

    const result = await orch.pollOnce(FROZEN);
    expect(result.firstRun).toBe(false);
    expect(queue.process).not.toHaveBeenCalled();
  });

  it("does NOT alert for a TODAY change of a different tutor", async () => {
    const { orch, queue } = runPoll({
      users: [user("u1", "Marcos Lopez")],
      entries: {
        // Salma Rizky's class changes today, but the registered user is Marcos.
        "2026-09-03": [entry("hx", { date: "2026-09-03", tutor: "Salma Rizky" })],
      },
    });

    await orch.pollOnce(FROZEN);
    expect(queue.process).not.toHaveBeenCalled();
  });

  it("routes two users with different tutors each their own alert", async () => {
    const { orch, queue } = runPoll({
      users: [
        user("c1", "Marcos Lopez"),
        user("c2", "Salma Rizky"),
      ],
      entries: {
        "2026-09-03": [
          entry("h1", { date: "2026-09-03", tutor: "Marcos Lopez" }),
          entry("h2", { date: "2026-09-03", tutor: "Salma Rizky" }),
        ],
      },
    });

    await orch.pollOnce(FROZEN);

    expect(queue.process).toHaveBeenCalledTimes(2);
    const first = queue.process.mock.calls[0][0] as AlertPayload;
    expect(first.recipientChatId).toBe("c1");
    expect(first.changes.map((c) => c.class.hash)).toEqual(["h1"]);
    const second = queue.process.mock.calls[1][0] as AlertPayload;
    expect(second.recipientChatId).toBe("c2");
    expect(second.changes.map((c) => c.class.hash)).toEqual(["h2"]);
  });

  it("queues ONE combined alert per user for multiple in-scope changes", async () => {
    const { orch, queue } = runPoll({
      users: [user("u1", "Marcos Lopez")],
      entries: {
        "2026-09-03": [entry("h1", { date: "2026-09-03" })],
        "2026-09-04": [entry("h2", { date: "2026-09-04" })],
        "2026-09-05": [entry("h5", { date: "2026-09-05" })], // out of scope
      },
    });

    await orch.pollOnce(FROZEN);

    expect(queue.process).toHaveBeenCalledTimes(1);
    const payload = queue.process.mock.calls[0][0] as AlertPayload;
    expect(payload.recipientChatId).toBe("u1");
    expect(payload.changes.map((c) => c.class.hash).sort()).toEqual(["h1", "h2"]);
  });

  it("computes the TODAY/TOMORROW scope in EACH user's own timezone (mirrors /today)", async () => {
    // Honolulu (UTC-10) at the frozen instant is still 2026-09-02 22:00 →
    // today = 09-02, tomorrow = 09-03. So a change dated 09-04 is day+2 for
    // the Honolulu user but TOMORROW for the Makassar user.
    const { orch, queue } = runPoll({
      users: [
        user("cH", "Marcos Lopez", "Pacific/Honolulu"),
        user("cM", "Marcos Lopez", "Asia/Makassar"),
      ],
      entries: {
        "2026-09-04": [entry("h4", { date: "2026-09-04" })],
      },
    });

    await orch.pollOnce(FROZEN);

    // Only the Makassar user is alerted (09-04 is their tomorrow).
    expect(queue.process).toHaveBeenCalledTimes(1);
    const payload = queue.process.mock.calls[0][0] as AlertPayload;
    expect(payload.recipientChatId).toBe("cM");
    expect(payload.changes).toHaveLength(1);
  });

  it("skips alerts with no registered users (info log only, no throw)", async () => {
    const captured = captureLogger();
    const { orch, queue } = runPoll({
      users: [],
      logger: captured.log,
      entries: {
        "2026-09-03": [entry("h1", { date: "2026-09-03" })],
      },
    });

    const result = await orch.pollOnce(FROZEN);
    // Cycle completes cleanly; queue receives only the no-op wake-flush payload.
    expect(result.errors).toBe(0);
    expect(result.firstRun).toBe(false);
    // No alert payload with real changes is ever queued.
    expect(queue.payloads.every((p) => p.changes.length === 0)).toBe(true);
    // Zero registered users keeps the info-level message (not the warn).
    const info = captured.lines.find(
      (l) => l.msg === "poll:no registered users; skipping alerts (changes logged only)",
    );
    expect(info).toBeDefined();
    expect(info!.level).toBe(30);
  });

  it("warns once when the users port is absent (no legacy broadcast fallback)", async () => {
    const captured = captureLogger();
    const { orch, queue } = runPoll({
      noUsersPort: true,
      logger: captured.log,
      entries: {
        "2026-09-03": [entry("h1", { date: "2026-09-03" })],
      },
    });

    await orch.pollOnce(FROZEN);
    expect(queue.payloads.every((p) => p.changes.length === 0)).toBe(true);
    // Missing port → warn-level message, NOT the info-level "no registered users".
    const warn = captured.lines.find(
      (l) => l.msg === "orchestrator:per-user alerting disabled (users port not wired)",
    );
    expect(warn).toBeDefined();
    expect(warn!.level).toBe(40);
    expect(
      captured.lines.some(
        (l) => l.msg === "poll:no registered users; skipping alerts (changes logged only)",
      ),
    ).toBe(false);
  });

  it("matches the registered tutor case-insensitively (trimmed)", async () => {
    // Registered with padding + lowercase; class entry uses exact mixed case.
    const { orch, queue } = runPoll({
      users: [user("c1", "  marcos lopez  ")],
      entries: {
        "2026-09-03": [entry("h1", { date: "2026-09-03", tutor: "Marcos Lopez" })],
      },
    });

    await orch.pollOnce(FROZEN);
    expect(queue.process).toHaveBeenCalledTimes(1);
    const payload = queue.process.mock.calls[0][0] as AlertPayload;
    expect(payload.recipientChatId).toBe("c1");
    expect(payload.changes.map((c) => c.class.hash)).toEqual(["h1"]);
  });

  it("defaults a missing user tz to Asia/Jakarta (no throw, /today-consistent scope)", async () => {
    // At 2026-09-03T16:30Z Jakarta is 09-03 23:30 → today 09-03, tomorrow
    // 09-04; Makassar would already be 09-04 00:30 → tomorrow 09-05. So a
    // 09-05 change must NOT alert under the Jakarta default (and must not
    // throw on the missing tz either).
    const late = new Date("2026-09-03T16:30:00.000Z");
    const { orch, queue } = runPoll({
      users: [user("u1", "Marcos Lopez", "")], // missing tz
      entries: {
        "2026-09-05": [entry("h5", { date: "2026-09-05" })],
      },
    });

    const result = await orch.pollOnce(late);
    expect(result.errors).toBe(0);
    expect(queue.process).not.toHaveBeenCalled();

    // A change dated tomorrow-in-Jakarta (09-04) DOES alert under the default.
    const { orch: o2, queue: q2 } = runPoll({
      users: [user("u1", "Marcos Lopez", "")],
      entries: {
        "2026-09-04": [entry("h4", { date: "2026-09-04" })],
      },
    });
    await o2.pollOnce(late);
    expect(q2.process).toHaveBeenCalledTimes(1);
    const payload = q2.process.mock.calls[0][0] as AlertPayload;
    expect(payload.recipientChatId).toBe("u1");
    expect(payload.changes.map((c) => c.class.hash)).toEqual(["h4"]);
  });

  it("logs only PII-free aggregate counts during dispatch (no chat ids, no tutor names)", async () => {
    const captured = captureLogger();
    const { orch, queue } = runPoll({
      logger: captured.log,
      users: [user("c1", "Marcos Lopez"), user("c2", "Salma Rizky")],
      entries: {
        "2026-09-03": [
          entry("h1", { date: "2026-09-03", tutor: "Marcos Lopez" }),
          entry("h2", { date: "2026-09-03", tutor: "Salma Rizky" }),
        ],
      },
    });

    await orch.pollOnce(FROZEN);
    expect(queue.process).toHaveBeenCalledTimes(2);

    const aggregate = captured.lines.find((l) => l.msg === "poll:per-user alerts queued");
    expect(aggregate).toBeDefined();
    expect(aggregate!.recipients).toBe(2);
    expect(aggregate!.alerts).toBe(2);

    // PII-free: no chatId/tutor fields, and no raw ids/names in any log line.
    for (const line of captured.lines) {
      expect(line).not.toHaveProperty("chatId");
      expect(line).not.toHaveProperty("tutor");
      expect(JSON.stringify(line)).not.toMatch(/c1|c2/);
    }
  });
});
