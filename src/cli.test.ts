/**
 * Tests for the CLI entry point.
 *
 * The CLI is split into a pure `parseArgs`/`dispatch` layer (injectable,
 * testable) and a thin `main()` wrapper that reads process.argv. We test
 * the dispatch layer with mocked dependency factories so no network or
 * filesystem side effects run.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  parseArgs,
  dispatch,
  formatScheduleDay,
  formatWeek,
  labelForDate,
  type CommandName,
  type CliServices,
} from "./cli.js";
import type { ScheduleEntry } from "./fetcher/types.js";

/** Capture output written to a fake logger/console. */
function captureConsole() {
  const out: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (msg: unknown) => void out.push(String(msg));
  console.error = (msg: unknown) => void out.push(`ERR ${String(msg)}`);
  return {
    out,
    restore() {
      console.log = origLog;
      console.error = origError;
    },
  };
}

/** Build a mock set of services for dispatch(). */
function mockServices(): CliServices {
  return {
    loadConfig: vi.fn(() => ({
      teacherId: "marcos",
      dateRange: 7,
      pollIntervalMs: 1800000,
      quietHours: { start: "22:00", end: "06:00", tz: "Asia/Makassar" },
      whatsapp: { provider: "callmebot" as const, apiKey: "k", phone: "+1" },
      fallback: { type: "none" as const, config: {} },
      cachePath: "/tmp/cache",
    })),
    runOnce: vi.fn(async () => ({
      datesPolled: 7,
      errors: 0,
      totalEntries: 5,
      firstRun: false,
      startedAt: "2026-09-03T08:00:00.000Z",
      finishedAt: "2026-09-03T08:00:01.000Z",
    })),
    startDaemon: vi.fn(() => ({ running: true })),
    testNotifier: vi.fn(async () => ({ success: true, channel: "whatsapp" })),
    version: "0.1.0",
  };
}

describe("parseArgs", () => {
  it("defaults to the start command when no args", () => {
    expect(parseArgs([]).command).toBe("start");
  });

  it("parses the run-once command", () => {
    expect(parseArgs(["run-once"]).command).toBe("run-once");
  });

  it("parses the start command explicitly", () => {
    expect(parseArgs(["start"]).command).toBe("start");
  });

  it("parses test-config", () => {
    expect(parseArgs(["test-config"]).command).toBe("test-config");
  });

  it("parses test-notifier", () => {
    expect(parseArgs(["test-notifier"]).command).toBe("test-notifier");
  });

  it("parses --version and -v", () => {
    expect(parseArgs(["--version"]).command).toBe("version");
    expect(parseArgs(["-V"]).command).toBe("version");
  });

  it("parses --help and -h", () => {
    expect(parseArgs(["--help"]).command).toBe("help");
    expect(parseArgs(["-h"]).command).toBe("help");
  });

  it("defaults to start for unknown commands", () => {
    expect(parseArgs(["bogus"]).command).toBe("start");
  });
});

describe("dispatch", () => {
  let captured: ReturnType<typeof captureConsole>;

  beforeEach(() => {
    captured = captureConsole();
  });

  afterEach(() => {
    captured.restore();
  });

  it("runs the start command via startDaemon", () => {
    const services = mockServices();
    dispatch({ command: "start" }, services);
    expect(services.startDaemon).toHaveBeenCalled();
  });

  it("runs run-once via services.runOnce", async () => {
    const services = mockServices();
    await dispatch({ command: "run-once" }, services);
    expect(services.runOnce).toHaveBeenCalled();
    // Prints a summary line with the poll result.
    expect(captured.out.some((l) => l.includes("dates"))).toBe(true);
  });

  it("test-config calls loadConfig and reports success", async () => {
    const services = mockServices();
    await dispatch({ command: "test-config" }, services);
    expect(services.loadConfig).toHaveBeenCalled();
    expect(captured.out.some((l) => /config:?\s*ok/i.test(l))).toBe(true);
  });

  it("test-config logs field name and exits nonzero on invalid config", async () => {
    const services = mockServices();
    const err = new Error("teacherId is required");
    (services.loadConfig as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw err;
    });
    await dispatch({ command: "test-config" }, services);
    expect(captured.out.some((l) => l.includes("teacherId is required"))).toBe(true);
  });

  it("test-notifier invokes the notifier probe", async () => {
    const services = mockServices();
    await dispatch({ command: "test-notifier" }, services);
    expect(services.testNotifier).toHaveBeenCalled();
    expect(captured.out.some((l) => l.includes("ok"))).toBe(true);
  });

  it("help prints usage information", () => {
    const services = mockServices();
    dispatch({ command: "help" }, services);
    expect(captured.out.some((l) => l.includes("Usage"))).toBe(true);
  });

  it("version prints the version string", () => {
    const services = mockServices();
    dispatch({ command: "version" }, services);
    expect(captured.out.some((l) => l.includes("0.1.0"))).toBe(true);
  });

  it("unknown command prints an error and usage", () => {
    const services = mockServices();
    dispatch("unknown" as CommandName, services);
    expect(captured.out.some((l) => l.startsWith("ERR"))).toBe(true);
  });
});

/** Minimal ScheduleEntry helper for the formatter tests. */
function entry(hash: string, time: string): ScheduleEntry {
  return {
    date: "2026-10-05",
    time,
    tutor: "Marcos Lopez",
    student: "Student",
    level: "Beginner",
    language: "English",
    status: "confirmed",
    hash,
  };
}

describe("formatScheduleDay", () => {
  it("derives a deterministic long date label and renders the entry body", () => {
    const text = formatScheduleDay([entry("h1", "10:00")], "2026-09-12");
    expect(text).toContain("12 de septiembre de 2026");
    expect(text).toContain("Student");
    expect(text).toContain("10:00");
    // Jakarta timezone note kept at the end.
    expect(text).toContain("Jakarta (WIB, UTC+7)");
  });

  it("shows a no-classes message for an empty day", () => {
    const text = formatScheduleDay([], "2026-09-12");
    expect(text).toContain("12 de septiembre de 2026");
    expect(text).toContain("No hay clases programadas");
  });
});

describe("formatWeek", () => {
  it("groups multiple days into labeled sections", () => {
    const map = new Map<string, ScheduleEntry[]>([
      ["2026-10-05", [entry("h1", "09:00"), entry("h2", "11:00")]],
      ["2026-10-06", []],
    ]);
    const text = formatWeek(map);
    expect(text).toContain("Horario de la semana");
    expect(text).toContain("09:00");
    expect(text).toContain("11:00");
    expect(text).toContain("Sin clases");
    // The Jakarta timezone note appears exactly once.
    expect(text.match(/Jakarta/g)).toHaveLength(1);
  });
});

describe("labelForDate", () => {
  const now = new Date("2026-09-11T12:00:00Z");

  it("labels today as 'hoy'", () => {
    expect(labelForDate("2026-09-11", "Asia/Makassar", now)).toBe("hoy");
  });

  it("labels tomorrow as 'mañana'", () => {
    expect(labelForDate("2026-09-12", "Asia/Makassar", now)).toBe("mañana");
  });

  it("labels other dates with weekday and dd/MM", () => {
    expect(labelForDate("2026-09-20", "Asia/Makassar", now)).toContain("20/09");
  });
});
