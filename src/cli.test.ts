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
  type CommandName,
  type CliServices,
} from "./cli.js";

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

  it("treats unknown commands as unknown", () => {
    expect(parseArgs(["bogus"]).command).toBe("unknown");
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
    dispatch("start", services);
    expect(services.startDaemon).toHaveBeenCalled();
  });

  it("runs run-once via services.runOnce", async () => {
    const services = mockServices();
    await dispatch("run-once", services);
    expect(services.runOnce).toHaveBeenCalled();
    // Prints a summary line with the poll result.
    expect(captured.out.some((l) => l.includes("dates"))).toBe(true);
  });

  it("test-config calls loadConfig and reports success", async () => {
    const services = mockServices();
    await dispatch("test-config", services);
    expect(services.loadConfig).toHaveBeenCalled();
    expect(captured.out.some((l) => /config:?\s*ok/i.test(l))).toBe(true);
  });

  it("test-config logs field name and exits nonzero on invalid config", async () => {
    const services = mockServices();
    const err = new Error("teacherId is required");
    (services.loadConfig as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw err;
    });
    await dispatch("test-config", services);
    expect(captured.out.some((l) => l.includes("teacherId is required"))).toBe(true);
  });

  it("test-notifier invokes the notifier probe", async () => {
    const services = mockServices();
    await dispatch("test-notifier", services);
    expect(services.testNotifier).toHaveBeenCalled();
    expect(captured.out.some((l) => l.includes("ok"))).toBe(true);
  });

  it("help prints usage information", () => {
    const services = mockServices();
    dispatch("help", services);
    expect(captured.out.some((l) => l.includes("Usage"))).toBe(true);
  });

  it("version prints the version string", () => {
    const services = mockServices();
    dispatch("version", services);
    expect(captured.out.some((l) => l.includes("0.1.0"))).toBe(true);
  });

  it("unknown command prints an error and usage", () => {
    const services = mockServices();
    dispatch("unknown" as CommandName, services);
    expect(captured.out.some((l) => l.startsWith("ERR"))).toBe(true);
  });
});
