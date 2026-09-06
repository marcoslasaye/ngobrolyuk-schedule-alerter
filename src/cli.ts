#!/usr/bin/env node

/**
 * Schedule Alerter CLI entry point.
 *
 * Commands:
 *   - start          Run as a local daemon on the configured poll interval
 *   - run-once       Fetch once, diff, and alert (used by GitHub Actions)
 *   - test-config    Validate config.yaml and exit
 *   - test-notifier  Probe the WhatsApp (and fallback) delivery channel
 *   - help / --help  Print usage information
 *   - version / -V   Print the package version
 *
 * The argument parser and command dispatcher are kept pure and injectable so
 * the CLI surface is unit-testable without network/filesystem side effects.
 * `main()` wires the real services and reads `process.argv`.
 */
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfigFile } from "./config/loader.js";
import type { ConfigSchema } from "./config/schema.js";
import { fetchSchedule } from "./fetcher/client.js";
import { parseSchedule } from "./fetcher/parser.js";
import type { ScheduleEntry } from "./fetcher/types.js";
import { diffEntries, type DiffResult } from "./differ/engine.js";
import { sendWhatsApp } from "./notifier/whatsapp.js";
import { sendFallback } from "./notifier/fallback.js";
import { AlertQueue } from "./notifier/queue.js";
import type { DeliveryResult } from "./notifier/types.js";
import { loadCache, saveCache } from "./scheduler/cache.js";
import {
  ScheduleOrchestrator,
  type OrchestratorDeps,
  type CycleResult,
} from "./scheduler/orchestrator.js";

/** Union of CLI command names. */
export type CommandName =
  | "start"
  | "run-once"
  | "test-config"
  | "test-notifier"
  | "horario-hoy"
  | "help"
  | "version"
  | "unknown";

/** Result of parsing argv — the command plus any captured flags. */
export interface ParsedArgs {
  command: CommandName;
}

/**
 * Injectable services that the dispatcher calls. `main()` supplies the real
 * implementations wired to the domains; tests supply mocks.
 */
export interface CliServices {
  /** Load and validate configuration. Throws on invalid config. */
  loadConfig(): ConfigSchema;
  /** Run a single poll cycle and return its summary. */
  runOnce(): Promise<CycleResult>;
  /** Start the daemon (long-running). */
  startDaemon(): { running: boolean };
  /** Probe the notifier channel with a test message. */
  testNotifier(): Promise<DeliveryResult>;
  /** Fetch and return today's schedule for Marcos Lopez. */
  fetchTodaySchedule(): Promise<ScheduleEntry[]>;
  /** Version string to report. */
  version: string;
}

/**
 * Parse raw argv into a ParsedArgs. Defaults to `start` when no command is
 * given (mirrors `npm start` behavior).
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const arg = argv[0];

  switch (arg) {
    case undefined:
    case "start":
      return { command: "start" };
    case "run-once":
      return { command: "run-once" };
    case "test-config":
      return { command: "test-config" };
    case "test-notifier":
      return { command: "test-notifier" };
    case "horario-hoy":
      return { command: "horario-hoy" };
    case "--help":
    case "-h":
      return { command: "help" };
    case "--version":
    case "-V":
      return { command: "version" };
    default:
      return { command: "unknown" };
  }
}

/** Print the usage banner to stdout. */
function printUsage(): void {
  console.log("Usage: schedule-alerter <command>");
  console.log("");
  console.log("Commands:");
  console.log("  start          Run as a local daemon on the configured poll interval");
  console.log("  run-once       Fetch once, diff, and alert (for GitHub Actions / manual)");
  console.log("  test-config    Validate config.yaml and exit");
  console.log("  test-notifier  Probe the WhatsApp/fallback delivery channel");
  console.log("  horario-hoy    Show today's classes for Marcos Lopez");
  console.log("  help, -h, --help     Show this help");
  console.log("  version, -V          Show the version");
}

/**
 * Dispatch a parsed command to the appropriate service.
 * All commands print to stdout/stderr; never throws.
 */
export async function dispatch(
  command: CommandName,
  services: CliServices,
): Promise<number> {
  switch (command) {
    case "start": {
      const result = services.startDaemon();
      if (result.running) {
        console.log("schedule-alerter: daemon started (Ctrl+C to stop).");
      } else {
        console.log("schedule-alerter: daemon already running.");
      }
      return 0;
    }
    case "run-once": {
      try {
        const summary = await services.runOnce();
        console.log(
          `poll: ${summary.datesPolled} dates, ${summary.totalEntries} entries, ` +
            `${summary.errors} errors` +
            (summary.firstRun ? " (first run — alert suppressed)" : ""),
        );
        return summary.errors > 0 ? 1 : 0;
      } catch (err) {
        console.error(`run-once failed: ${String(err)}`);
        return 1;
      }
    }
    case "test-config": {
      try {
        services.loadConfig();
        console.log("config: ok — configuration is valid.");
        return 0;
      } catch (err) {
        console.error(`config: invalid — ${String(err)}`);
        return 1;
      }
    }
    case "test-notifier": {
      try {
        const result = await services.testNotifier();
        if (result.success) {
          console.log(`notifier: ok — delivered via ${result.channel}.`);
          return 0;
        }
        console.error(`notifier: failed via ${result.channel} — ${result.error ?? "unknown"}`);
        return 1;
      } catch (err) {
        console.error(`notifier: error — ${String(err)}`);
        return 1;
      }
    }
    case "horario-hoy": {
      try {
        const entries = await services.fetchTodaySchedule();
        if (entries.length === 0) {
          console.log("📅 Hoy no hay clases para Marcos Lopez.");
          return 0;
        }
        console.log(`📅 Horario de hoy para Marcos Lopez (${entries.length} clase${entries.length > 1 ? "s" : ""}):`);
        console.log("");
        entries.forEach((e, i) => {
          const time = e.time;
          const student = e.student;
          const lang = e.language;
          const status = e.status;
          console.log(`  ${i + 1}. ${time}  →  ${student}  |  ${lang}  |  ${status}`);
        });
        return 0;
      } catch (err) {
        console.error(`horario-hoy failed: ${String(err)}`);
        return 1;
      }
    }
    case "help":
      printUsage();
      return 0;
    case "version":
      console.log(services.version);
      return 0;
    case "unknown":
    default:
      console.error(`unknown command.`);
      printUsage();
      return 1;
  }
}

/**
 * Build the real service container — wires every domain:
 * fetcher (client+parser), differ (engine), notifier (whatsapp+fallback+
 * formatter+queue), cache, and config.
 */
export function buildServices(version: string): CliServices {
  return {
    version,

    loadConfig() {
      return loadConfigFile();
    },

    runOnce() {
      const config = loadConfigFile();
      const orch = buildOrchestrator(config);
      return orch.pollOnce();
    },

    startDaemon() {
      const config = loadConfigFile();
      const orch = buildOrchestrator(config);
      orch.start(true);
      return { running: orch.running };
    },

    async testNotifier(): Promise<DeliveryResult> {
      const config = loadConfigFile();
      const testText = "schedule-alerter: test message from test-notifier.";
      const primary = await sendWhatsApp(testText, {
        phone: config.whatsapp.phone,
        apiKey: config.whatsapp.apiKey,
      });
      if (primary.success) {
        return primary;
      }
      // Probes the fallback channel as well so the user sees both paths.
      return sendFallback(testText, config.fallback);
    },

    async fetchTodaySchedule(): Promise<ScheduleEntry[]> {
      const config = loadConfigFile();
      const today = new Date().toISOString().split("T")[0];
      const raw = await fetchSchedule(today, {
        baseUrl: resolveBaseUrl(config),
      });
      return parseSchedule(raw.html, today);
    },
  };
}

/**
 * Wire an orchestrator with the full production dependency set for the
 * given config. All ports are composed here in one place.
 */
function buildOrchestrator(config: ConfigSchema): ScheduleOrchestrator {
  // FetcherPort: HTTP fetch + HTML parse for one date.
  const fetcher = {
    async fetch(date: string): Promise<ScheduleEntry[]> {
      const raw = await fetchSchedule(date, {
        baseUrl: resolveBaseUrl(config),
      });
      return parseSchedule(raw.html, date);
    },
  };

  // DifferPort.
  const differ = {
    diff(old: ScheduleEntry[], current: ScheduleEntry[]): DiffResult {
      return diffEntries(old, current);
    },
  };

  // NotifierPort: AlertQueue with real WhatsApp + fallback delivery.
  const queue = new AlertQueue({
    start: config.quietHours.start,
    end: config.quietHours.end,
    tz: config.quietHours.tz,
    onSend: (text) =>
      sendWhatsApp(text, {
        phone: config.whatsapp.phone,
        apiKey: config.whatsapp.apiKey,
      }),
    onFallback: (text) => sendFallback(text, config.fallback),
  });

  // CachePort.
  const cache = {
    load() {
      return loadCache(normalizeCachePath(config.cachePath));
    },
    save(schema: import("./scheduler/types.js").CacheSchema) {
      saveCache(schema, normalizeCachePath(config.cachePath));
    },
  };

  const deps: OrchestratorDeps = {
    fetcher,
    differ,
    queue: queue as OrchestratorDeps["queue"],
    cache,
    config,
  };
  return new ScheduleOrchestrator(deps);
}

/** Resolve the endpoint base URL from config (currently fixed single-site). */
function resolveBaseUrl(config: ConfigSchema): string {
  void config;
  return "https://ngobrolyuk.com";
}

/**
 * Normalize the configured cachePath. The default in config.yaml is
 * `~/.schedule-cache`, but cachePathFor() expects a directory path.
 * Empty cachePath falls back to the OS default via loadCache()/saveCache().
 */
function normalizeCachePath(cachePath: string): string | undefined {
  return cachePath && cachePath.trim() !== "" ? cachePath : undefined;
}

/**
 * Program entry point. Parses argv, builds real services, dispatches, and
 * sets the process exit code based on the command result.
 */
export function main(): void {
  const { command } = parseArgs(process.argv.slice(2));

  const version =
    process.env["npm_package_version"] ??
    (() => {
      try {
        // Best-effort read of package.json at runtime.
        const pkgPath = resolve(process.cwd(), "package.json");
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
        return pkg.version ?? "0.0.0";
      } catch {
        return "0.0.0";
      }
    })();

  const services = buildServices(version);

  void dispatch(command, services).then((code) => {
    if (code !== 0) {
      process.exitCode = code;
    }
  });
}

// Only run main() when this file is executed directly, not when imported.
const isMainModule =
  process.argv[1] != null &&
  process.argv[1].endsWith(fileURLToPath(import.meta.url).split(/[/\\]/).pop()!);

if (isMainModule) {
  main();
}
