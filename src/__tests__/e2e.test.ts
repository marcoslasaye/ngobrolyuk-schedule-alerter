/**
 * End-to-end test — run-once poll cycle against recorded HTML fixtures.
 *
 * Drives the REAL production pipeline (parser → differ → queue → formatter →
 * cache) from `src/index.ts` re-exports, replacing only the two external
 * side-effect boundaries:
 *   - the HTTP fetcher (serves recorded `__fixtures__/fetcher/*.html` instead
 *     of hitting the WP endpoint), and
 *   - the WhatsApp network call (delivery is captured, not transmitted).
 *
 * It proves the full run-once path works with recorded data and, crucially,
 * does so without crashing: each cycle returns cleanly, writes the cache, and
 * produces an alert payload of the expected shape that formats into a valid
 * message.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  ScheduleOrchestrator,
  diffEntries,
  parseSchedule,
  AlertQueue,
  formatAlert,
  loadCache,
  saveCache,
  type CacheSchema,
  type ScheduleEntry,
  type AlertPayload,
  type DeliveryResult,
} from "../index.js";

const FIXTURES_DIR = resolve("__fixtures__/fetcher");
/** Recorded, real response HTML for 2026-09-03 (3 class entries for Marcos Lopez). */
const SINGLE_DAY_HTML = readFileSync(
  join(FIXTURES_DIR, "schedule-single-day.html"),
  "utf8",
);
const EMPTY_HTML = readFileSync(
  join(FIXTURES_DIR, "schedule-empty.html"),
  "utf8",
);
const MALFORMED_HTML = readFileSync(
  join(FIXTURES_DIR, "schedule-malformed.html"),
  "utf8",
);

/** The date recorded in the single-day fixture. */
const FIXTURE_DATE = "2026-09-03";
/** Start of the polling window used for all cycles (frozen). */
const NOW = new Date("2026-09-03T08:00:00.000Z");

/** Recorded-fixture FetcherPort: serves the single-day fixture for its date. */
function fixtureFetcher(date: string) {
  if (date === FIXTURE_DATE) {
    return parseSchedule(SINGLE_DAY_HTML, date);
  }
  return [];
}

/**
 * Build the full production orchestrator composition for the E2E run.
 * `cacheDir` points at a throwaway temp directory; delivery is captured.
 */
function buildE2E(cacheDir: string): {
  orch: ScheduleOrchestrator;
  delivered: DeliveryResult[];
  deliveredText: string[];
} {
  const delivered: DeliveryResult[] = [];
  const deliveredText: string[] = [];

  const queue = new AlertQueue({
    start: "22:00",
    end: "06:00",
    tz: "Asia/Makassar",
    onSend: async (text: string): Promise<DeliveryResult> => {
      deliveredText.push(text);
      const result: DeliveryResult = { success: true, channel: "whatsapp" };
      delivered.push(result);
      return result;
    },
    onFallback: async (text: string): Promise<DeliveryResult> => {
      const result: DeliveryResult = { success: true, channel: "file" };
      delivered.push(result);
      return result;
    },
  });

  const orch = new ScheduleOrchestrator({
    config: {
      teacherId: "marcos",
      dateRange: 7,
      pollIntervalMs: 1800000,
      quietHours: { start: "22:00", end: "06:00", tz: "Asia/Makassar" },
      whatsapp: { provider: "callmebot", apiKey: "e2e-key", phone: "e2e-phone" },
      fallback: { type: "none", config: {} },
      cachePath: cacheDir,
    },
    fetcher: { fetch: fixtureFetcher },
    differ: { diff: diffEntries },
    queue: queue as never,
    cache: {
      load: () => loadCache(cacheDir),
      save: (schema: CacheSchema) => saveCache(schema, cacheDir),
    },
  });

  return { orch, delivered, deliveredText };
}

describe("E2E: run-once with recorded HTML fixtures", () => {
  let cacheDir: string;

  beforeAll(() => {
    cacheDir = mkdtempSync(join(tmpdir(), "schedule-e2e-"));
  });

  afterAll(() => {
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it("first run: fetches fixture entries, suppresses alert, and writes the cache", async () => {
    const { orch, delivered, deliveredText } = buildE2E(cacheDir);

    const result = await orch.pollOnce(NOW);

    // No crash — clean summary.
    expect(result.errors).toBe(0);
    expect(result.datesPolled).toBe(7);
    // The single-day fixture contributes its 3 entries (all for Marcos Lopez).
    expect(result.totalEntries).toBe(3);
    // First run (empty cache) must suppress the alert.
    expect(result.firstRun).toBe(true);
    expect(deliveredText).toEqual([]);

    // Cache must be written with the parsed fixture entries.
    const cachePath = resolveCache(cacheDir);
    expect(existsSync(cachePath)).toBe(true);
    const cache = loadCache(cacheDir);
    expect(cache.entries).toHaveLength(3);
    expect(typeof cache.lastFetch).toBe("string");
    expect(cache.lastFetch.length).toBeGreaterThan(0);
    // Entries keep their recorded fields + identity hash.
    expect(cache.entries[0]).toMatchObject({
      date: FIXTURE_DATE,
      time: "09:00 – 10:00",
      tutor: "Marcos Lopez",
      student: "Juan Pérez",
      language: "English",
      level: "",
      status: "Selesai",
    });
    expect(typeof cache.entries[0].hash).toBe("string");
    expect(cache.entries[0].hash.length).toBe(64);
  });

  it("second run with identical fixtures: no changes, no alert, no crash", async () => {
    const { orch, delivered, deliveredText } = buildE2E(cacheDir);

    const result = await orch.pollOnce(NOW);

    expect(result.errors).toBe(0);
    // Cache already populated → not first run.
    expect(result.firstRun).toBe(false);
    // No changes detected → nothing delivered.
    expect(deliveredText).toEqual([]);
    expect(delivered).toEqual([]);
  });

  it("detects a change and produces an alert payload of the expected shape", async () => {
    // Seed the cache with a schedule where one fixture class has a different
    // time, so a real `modified` change is produced on the next cycle.
    const seedEntries = fixtureFetcher(FIXTURE_DATE).map((e: ScheduleEntry, i: number) =>
      i === 0 ? { ...e, time: "09:30 – 10:30" } : e,
    );
    saveCache({ lastFetch: NOW.toISOString(), entries: seedEntries }, cacheDir);

    // Wrap the real AlertQueue so we can observe the exact AlertPayload the
    // orchestrator hands to `process()` without spoofing it.
    const delivered: DeliveryResult[] = [];
    const deliveredText: string[] = [];
    let capturedPayload: AlertPayload | null = null;
    const realQueue = new AlertQueue({
      start: "22:00",
      end: "06:00",
      tz: "Asia/Makassar",
      onSend: async (text: string): Promise<DeliveryResult> => {
        deliveredText.push(text);
        const result: DeliveryResult = { success: true, channel: "whatsapp" };
        delivered.push(result);
        return result;
      },
      onFallback: async (text: string): Promise<DeliveryResult> => {
        const result: DeliveryResult = { success: true, channel: "file" };
        delivered.push(result);
        return result;
      },
    });
    const capturingQueue = {
      process: async (payload: AlertPayload, now?: Date) => {
        capturedPayload = payload;
        await realQueue.process(payload, now);
      },
      flush: (now?: Date) => realQueue.flush(now),
      isQuiet: (date: Date) => realQueue.isQuiet(date),
      get queuedCount() {
        return realQueue.queuedCount;
      },
      get consecutiveFailures() {
        return realQueue.consecutiveFailures;
      },
    };

    const orch = new ScheduleOrchestrator({
      config: {
        teacherId: "marcos",
        dateRange: 7,
        pollIntervalMs: 1800000,
        quietHours: { start: "22:00", end: "06:00", tz: "Asia/Makassar" },
        whatsapp: { provider: "callmebot", apiKey: "e2e-key", phone: "e2e-phone" },
        fallback: { type: "none", config: {} },
        cachePath: cacheDir,
      },
      fetcher: { fetch: fixtureFetcher },
      differ: { diff: diffEntries },
      queue: capturingQueue as never,
      cache: {
        load: () => loadCache(cacheDir),
        save: (schema: CacheSchema) => saveCache(schema, cacheDir),
      },
    });

    const result = await orch.pollOnce(NOW);
    expect(result.errors).toBe(0);
    expect(result.firstRun).toBe(false);

    // A real alert was delivered exactly once.
    expect(deliveredText.length).toBe(1);
    expect(deliveredText[0]).toContain("Schedule Change Alert");

    // The alert payload handed to the queue has the expected shape.
    expect(capturedPayload).not.toBeNull();
    expect(capturedPayload!.changes).toHaveLength(1);
    expect(capturedPayload!.changes[0].type).toBe("modified");
    expect(capturedPayload!.changes[0].class).toMatchObject({
      date: FIXTURE_DATE,
      tutor: "Marcos Lopez",
      student: "Juan Pérez",
    });
    expect(typeof capturedPayload!.timestamp).toBe("string");
    expect(new Date(capturedPayload!.timestamp).getTime()).not.toBeNaN();
    expect(capturedPayload!.dateRange.start).toBe(FIXTURE_DATE);
    expect(capturedPayload!.dateRange.end).toBe("2026-09-09");

    // The formatted message renders through the real formatter without
    // crashing and includes the affected student.
    const formatted = formatAlert(capturedPayload!);
    expect(formatted).toContain("Juan Pérez");
    expect(formatted).toContain("Sep 3");

    // DeliveryResult captured.
    expect(delivered).toHaveLength(1);
    expect(delivered[0].success).toBe(true);
    expect(delivered[0].channel).toBe("whatsapp");
  });

  it("handles malformed fixture HTML without crashing", async () => {
    const malformedOrch = new ScheduleOrchestrator({
      config: {
        teacherId: "marcos",
        dateRange: 7,
        pollIntervalMs: 1800000,
        quietHours: { start: "22:00", end: "06:00", tz: "Asia/Makassar" },
        whatsapp: { provider: "callmebot", apiKey: "k", phone: "p" },
        fallback: { type: "none", config: {} },
        cachePath: cacheDir,
      },
      fetcher: {
        fetch: (date: string) => (date === FIXTURE_DATE ? parseSchedule(MALFORMED_HTML, date) : []),
      },
      differ: { diff: diffEntries },
      queue: queueFor([]) as never,
      cache: {
        load: () => loadCache(cacheDir),
        save: (schema: CacheSchema) => saveCache(schema, cacheDir),
      },
    });

    const result = await malformedOrch.pollOnce(NOW);
    // Parser returns [] for malformed HTML → 0 entries, no crash.
    expect(result.errors).toBe(0);
    expect(result.totalEntries).toBe(0);
  });
});

/** Tiny queue stub used only when we do not expect delivery. */
function queueFor(_texts: string[]) {
  return new AlertQueue({
    start: "22:00",
    end: "06:00",
    tz: "Asia/Makassar",
    onSend: async () => ({ success: true, channel: "whatsapp" }),
    onFallback: async () => ({ success: true, channel: "file" }),
  });
}

/** Absolute path of the cache JSON file inside a dir. */
function resolveCache(dir: string): string {
  return join(resolve(dir), "last-schedule.json");
}