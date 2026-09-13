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
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { formatInTimeZone } from "date-fns-tz";
import { loadConfigFile } from "./config/loader.js";
import type { ConfigSchema } from "./config/schema.js";
import { fetchSchedule } from "./fetcher/client.js";
import { parseSchedule } from "./fetcher/parser.js";
import type { ScheduleEntry } from "./fetcher/types.js";
import { diffEntries, type DiffResult } from "./differ/engine.js";
import { sendWhatsApp } from "./notifier/whatsapp.js";
import { ScheduleBot, addDays } from "./notifier/bot.js";
import { sendFallback } from "./notifier/fallback.js";
import { AlertQueue } from "./notifier/queue.js";
import type { DeliveryResult } from "./notifier/types.js";
import { UserStore } from "./registry/userStore.js";
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
  | "today"
  | "help"
  | "version"
  | "unknown";

/** Result of parsing argv — the command plus any captured flags. */
export interface ParsedArgs {
  command: CommandName;
  html?: boolean;
  telegram?: boolean;
  output?: string;
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
  /** Generate HTML for today's schedule. */
  generateScheduleHtml(entries: ScheduleEntry[], outputPath?: string): Promise<void>;
  /** Send today's schedule to Telegram. */
  sendScheduleToTelegram(entries: ScheduleEntry[]): Promise<DeliveryResult>;
  /** Version string to report. */
  version: string;
}

/**
 * Legacy single-teacher name kept for the CLI / alert-pipeline paths
 * (run-once, daemon poll, daily summary, today). Those paths still
 * target one teacher; slice 4 will make them per registered user.
 */
const LEGACY_TUTOR = "Marcos Lopez";

/**
 * Parse raw argv into a ParsedArgs. Defaults to `start` when no command is
 * given (mirrors `npm start` behavior).
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = { command: "unknown" };
  let commandFound = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    // Handle long flags (--xxx)
    if (arg.startsWith("--")) {
      if (arg === "--html") args.html = true;
      else if (arg === "--telegram") args.telegram = true;
      else if (arg === "--help" || arg === "-h") {
        args.command = "help";
        commandFound = true;
      }
      else if (arg === "--version" || arg === "-V") {
        args.command = "version";
        commandFound = true;
      }
      else if (arg.startsWith("--output=")) args.output = arg.split("=")[1];
      else if (arg === "--output") args.output = argv[++i];
    }
    // Handle short flags (-x) that are not part of a word
    else if (arg.startsWith("-") && arg.length === 2) {
      const shortFlag = arg[1];
      if (shortFlag === "h") {
        args.command = "help";
        commandFound = true;
      } else if (shortFlag === "V") {
        args.command = "version";
        commandFound = true;
      }
    }
    // Handle positional commands
    else if (!commandFound && !arg.startsWith("-")) {
      switch (arg) {
        case "start":
        case "run-once":
        case "test-config":
        case "test-notifier":
          args.command = arg;
          commandFound = true;
          break;
        case "today":
        case "horario-hoy": // Legacy alias for "today".
          args.command = "today";
          commandFound = true;
          break;
        case "help":
        case "version":
          args.command = arg;
          commandFound = true;
          break;
        default:
          // unknown command - keep as unknown
          break;
      }
    }
  }

  if (!commandFound) {
    // Default to start if no command found
    args.command = "start";
  }

  return args;
}

/** Print the usage banner to stdout. */
function printUsage(): void {
  console.log("Usage: schedule-alerter <command> [options]");
  console.log("");
  console.log("Commands:");
  console.log("  start          Run as a local daemon on the configured poll interval");
  console.log("  run-once       Fetch once, diff, and alert (for GitHub Actions / manual)");
  console.log("  test-config    Validate config.yaml and exit");
  console.log("  test-notifier  Probe the WhatsApp/fallback delivery channel");
  console.log("  today          Show today's classes for Marcos Lopez (alias: horario-hoy)");
  console.log("");
  console.log("Options (for today):");
  console.log("  --html              Generate HTML file");
  console.log("  --telegram          Send to Telegram");
  console.log("  --output <path>     Output path for HTML (default: today.html)");
  console.log("");
  console.log("  help, -h, --help     Show this help");
  console.log("  version, -V          Show the version");
}

/**
 * Dispatch a parsed command to the appropriate service.
 * All commands print to stdout/stderr; never throws.
 */
export async function dispatch(
  args: ParsedArgs,
  services: CliServices,
): Promise<number> {
  switch (args.command) {
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
    case "today": {
      try {
        const entries = await services.fetchTodaySchedule();
        
        // Handle --html flag
        if (args.html) {
          const outputPath = args.output || "today.html";
          await services.generateScheduleHtml(entries, outputPath);
          console.log(`📄 HTML generated: ${outputPath}`);
        }
        
        // Handle --telegram flag
        if (args.telegram) {
          const result = await services.sendScheduleToTelegram(entries);
          if (result.success) {
            console.log(`📱 Sent to Telegram via ${result.channel}`);
          } else {
            console.error(`📱 Failed to send to Telegram: ${result.error ?? "unknown"}`);
            return 1;
          }
        }
        
        // Default: just print to console
        if (!args.html && !args.telegram) {
          if (entries.length === 0) {
            console.log(`📅 No classes for ${LEGACY_TUTOR} today.`);
            return 0;
          }
          console.log(`📅 Today's schedule for ${LEGACY_TUTOR} (${entries.length} classes):`);
          console.log("");
          entries.forEach((e, i) => {
            const time = e.time;
            const student = e.student;
            const lang = e.language;
            const status = e.status;
            console.log(`  ${i + 1}. ${time}  →  ${student}  |  ${lang}  |  ${status}`);
          });
        }
        return 0;
      } catch (err) {
        console.error(`today command failed: ${String(err)}`);
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
      const today = formatInTimeZone(new Date(), config.dailySummary.tz, "yyyy-MM-dd");
      const raw = await fetchSchedule(today, {
        baseUrl: resolveBaseUrl(config),
      });
      return parseSchedule(raw.html, today, [LEGACY_TUTOR]);
    },

    async generateScheduleHtml(entries: ScheduleEntry[], outputPath?: string): Promise<void> {
      const html = generateScheduleHtml(entries);
      const { writeFileSync } = await import("node:fs");
      writeFileSync(outputPath || "today.html", html);
    },

    async sendScheduleToTelegram(entries: ScheduleEntry[]): Promise<DeliveryResult> {
      const config = loadConfigFile();
      const today = formatInTimeZone(new Date(), config.dailySummary.tz, "yyyy-MM-dd");
      const text = formatScheduleDay(entries, today);
      return sendFallback(text, config.fallback);
    },
  };
}

/**
 * Wire an orchestrator with the full production dependency set for the
 * given config. All ports are composed here in one place.
 */
function buildOrchestrator(config: ConfigSchema): ScheduleOrchestrator {
  // FetcherPort: HTTP fetch + HTML parse for one date (legacy single tutor).
  const fetcher = {
    async fetch(date: string): Promise<ScheduleEntry[]> {
      const raw = await fetchSchedule(date, {
        baseUrl: resolveBaseUrl(config),
      });
      return parseSchedule(raw.html, date, [LEGACY_TUTOR]);
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

  // User registry for the interactive bot: chatId → tutor name
  // (persists to ~/.schedule-alerter/users.json).
  const userStore = new UserStore(
    join(homedir(), ".schedule-alerter", "users.json"),
  );
  void userStore.load(); // kick off the initial read eagerly

  const deps: OrchestratorDeps = {
    fetcher,
    differ,
    queue: queue as OrchestratorDeps["queue"],
    cache,
    summary: {
      async sendToday(): Promise<DeliveryResult> {
        const today = formatInTimeZone(new Date(), config.dailySummary.tz, "yyyy-MM-dd");
        const raw = await fetchSchedule(today, {
          baseUrl: resolveBaseUrl(config),
        });
        const entries = parseSchedule(raw.html, today, [LEGACY_TUTOR]);
        const text = formatScheduleDay(entries, today);
        return sendFallback(text, config.fallback);
      },
    },
    // Interactive Telegram commands (/today, /tomorrow, /week, /register) —
    // only when the fallback channel is Telegram and a bot token is configured.
    bot: config.fallback.type === "telegram" && config.fallback.config.botToken
      ? new ScheduleBot(String(config.fallback.config.botToken), {
          tz: config.dailySummary.tz,
          fetchByDate: async (date, tutorName) => {
            const raw = await fetchSchedule(date, {
              baseUrl: resolveBaseUrl(config),
            });
            return parseSchedule(
              raw.html,
              date,
              tutorName ? [tutorName] : undefined,
            );
          },
          formatDay: formatScheduleDay,
          formatWeek,
          labelFor: (date) => labelForDate(date, config.dailySummary.tz),
          findUser: async (chatId) => {
            const u = await userStore.findByChatId(chatId);
            return u ? { tutorName: u.tutorName, tz: u.tz } : undefined;
          },
          registerUser: async (chatId, tutorName) => {
            await userStore.upsert({
              chatId,
              tutorName,
              tz: "Asia/Makassar",
              registeredAt: new Date().toISOString(),
            });
          },
        })
      : undefined,
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
 * Generate a beautiful HTML schedule page.
 */
function generateScheduleHtml(entries: ScheduleEntry[]): string {
  const today = new Date().toLocaleDateString("en-GB", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "Asia/Makassar",
  });

  const cards = entries.map((e, i) => `
    <article class="class-card" style="--i: ${i}">
      <div class="class-time">${e.time}</div>
      <div class="class-info">
        <div class="class-student">${escapeHtml(e.student)}</div>
        <div class="class-meta">
          <span class="class-language">${escapeHtml(e.language)}</span>
          <span class="class-status status-${e.status.toLowerCase()}">${escapeHtml(e.status)}</span>
        </div>
      </div>
    </article>
  `).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Schedule for ${today} - Marcos Lopez</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg: #0f172a;
      --bg-card: #1e293b;
      --fg: #f1f5f9;
      --fg-muted: #94a3b8;
      --accent: #22d3ee;
      --accent-glow: rgba(34, 211, 238, 0.3);
      --success: #22c55e;
      --warning: #f59e0b;
      --error: #ef4444;
      --border: #334155;
    }
    @media (prefers-color-scheme: light) {
      :root {
        --bg: #f8fafc;
        --bg-card: #ffffff;
        --fg: #0f172a;
        --fg-muted: #64748b;
        --accent: #06b6d4;
        --accent-glow: rgba(6, 182, 212, 0.2);
        --border: #e2e8f0;
      }
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      background: var(--bg);
      color: var(--fg);
      min-height: 100vh;
      padding: 2rem 1rem;
      line-height: 1.6;
    }
    .container {
      max-width: 600px;
      margin: 0 auto;
    }
    header {
      text-align: center;
      margin-bottom: 2rem;
      padding-bottom: 1.5rem;
      border-bottom: 1px solid var(--border);
    }
    h1 {
      font-size: clamp(1.75rem, 5vw, 2.5rem);
      font-weight: 700;
      background: linear-gradient(135deg, var(--fg), var(--accent));
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
      margin-bottom: 0.5rem;
    }
    .date {
      color: var(--fg-muted);
      font-size: 1.1rem;
    }
    .count {
      display: inline-block;
      margin-top: 0.75rem;
      padding: 0.35rem 1rem;
      background: var(--accent-glow);
      color: var(--accent);
      border-radius: 9999px;
      font-size: 0.875rem;
      font-weight: 600;
    }
    .schedule {
      display: flex;
      flex-direction: column;
      gap: 1rem;
    }
    .class-card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 1.25rem 1.5rem;
      display: flex;
      align-items: center;
      gap: 1.25rem;
      opacity: 0;
      animation: slideIn 0.4s ease forwards;
      animation-delay: calc(var(--i) * 0.08s);
      transition: transform 0.2s ease, box-shadow 0.2s ease;
    }
    .class-card:hover {
      transform: translateX(4px);
      box-shadow: 0 8px 32px var(--accent-glow);
      border-color: var(--accent);
    }
    @keyframes slideIn {
      from { opacity: 0; transform: translateX(-20px); }
      to { opacity: 1; transform: translateX(0); }
    }
    .class-time {
      font-family: "SF Mono", "Fira Code", monospace;
      font-size: 1.1rem;
      font-weight: 600;
      color: var(--accent);
      white-space: nowrap;
      min-width: 100px;
    }
    .class-info { flex: 1; }
    .class-student {
      font-size: 1.1rem;
      font-weight: 600;
      margin-bottom: 0.25rem;
    }
    .class-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
      align-items: center;
    }
    .class-language {
      font-size: 0.8rem;
      font-weight: 500;
      padding: 0.25rem 0.75rem;
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 9999px;
      color: var(--fg-muted);
    }
    .class-status {
      font-size: 0.75rem;
      font-weight: 600;
      padding: 0.25rem 0.65rem;
      border-radius: 9999px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .status-selesai { background: rgba(34, 197, 94, 0.15); color: var(--success); }
    .status-ditunda { background: rgba(245, 158, 11, 0.15); color: var(--warning); }
    .status-selanjutnya { background: rgba(34, 211, 238, 0.15); color: var(--accent); }
    .status-confirmed { background: rgba(34, 197, 94, 0.15); color: var(--success); }
    .status-pending { background: rgba(245, 158, 11, 0.15); color: var(--warning); }
    .status-cancelled { background: rgba(239, 68, 68, 0.15); color: var(--error); }
    .empty-state {
      text-align: center;
      padding: 3rem 1rem;
      color: var(--fg-muted);
    }
    .empty-state svg { width: 80px; height: 80px; margin-bottom: 1rem; opacity: 0.5; }
    footer {
      margin-top: 3rem;
      text-align: center;
      color: var(--fg-muted);
      font-size: 0.875rem;
    }
    @media (max-width: 480px) {
      .class-card { flex-direction: column; align-items: flex-start; gap: 0.75rem; }
      .class-time { font-size: 1rem; }
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>📅 Today's Schedule</h1>
      <div class="date">Marcos Lopez · ${today}</div>
      <div class="count">${entries.length} class${entries.length !== 1 ? "s" : ""}</div>
    </header>
    ${entries.length === 0
      ? `<div class="empty-state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 7V3M12 7V3M16 7V3M10 10H14M8 14H16M8 18H16"/></svg><p>No classes scheduled today</p></div>`
      : `<div class="schedule">${cards}</div>`
    }
    <footer>
      <p>Generated automatically · Ngobrol Yuk Schedule</p>
    </footer>
  </div>
</body>
</html>`;
}

/**
 * Long English label for a YYYY-MM-DD date, e.g. "Saturday, 12 September 2026".
 * Deterministic: the date is parsed at noon UTC so the calendar day never
 * shifts across timezone boundaries.
 */
function longDateLabel(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day, 12));
  return parsed.toLocaleDateString("en-GB", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "Asia/Makassar",
  });
}

/**
 * Human label for a date vs today (in `tz`): "today", "tomorrow", or a
 * weekday + dd/MM label (e.g. "Thursday, 12/09"). Pure: `now` is
 * injectable so tests are deterministic.
 */
export function labelForDate(
  date: string,
  tz: string,
  now: Date = new Date(),
): string {
  const today = formatInTimeZone(now, tz, "yyyy-MM-dd");
  if (date === today) {
    return "today";
  }
  if (date === addDays(today, 1)) {
    return "tomorrow";
  }
  const [year, month, day] = date.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day, 12));
  return parsed.toLocaleDateString("en-GB", {
    weekday: "long",
    month: "2-digit",
    day: "2-digit",
    timeZone: tz,
  });
}

/** Render a single schedule entry as one numbered Telegram HTML block. */
function renderEntry(entry: ScheduleEntry, index: number): string {
  const statusEmoji = {
    selesai: "✅",
    ditunda: "⏳",
    selanjutnya: "▶️",
    confirmed: "✅",
    pending: "⏳",
    cancelled: "❌",
  }[entry.status.toLowerCase()] || "📍";

  return (
    `${index + 1}. ${statusEmoji} <b>${entry.time}</b>\n` +
    `    👤 ${entry.student}\n` +
    `    🌐 ${entry.language} · ${entry.status}`
  );
}

/**
 * Format a single day's schedule for the Telegram message (HTML).
 * The header label derives deterministically from the given date, and the
 * "today"/"tomorrow" scope is resolved against today in the owner timezone.
 */
export function formatScheduleDay(entries: ScheduleEntry[], date: string): string {
  const scope = labelForDate(date, "Asia/Makassar");
  const headerScope =
    scope === "today" ? "Today's schedule" : scope === "tomorrow" ? "Tomorrow's schedule" : scope;
  const header = `📅 <b>${headerScope} (${longDateLabel(date)})</b>`;

  if (entries.length === 0) {
    return `${header}\n\n😴 No classes scheduled.\n\n🕐 Times shown in Jakarta time (WIB, UTC+7)`;
  }

  let text = `${header}\n`;
  const teacher = entries[0]?.tutor ?? "";
  text += `👨‍🏫 <b>${escapeHtml(teacher)}</b> · ${entries.length} class${entries.length !== 1 ? "s" : ""}\n`;
  text += `🕐 Times shown in Jakarta time (WIB, UTC+7)\n\n`;

  text += entries.map(renderEntry).join("\n\n");
  text += "\n\n<i>Ngobrol Yuk Schedule</i>";
  return text;
}

/**
 * Format multiple days' schedules (keyed by YYYY-MM-DD) as one weekly
 * Telegram message (HTML). Each day is a labeled section; days with no
 * entries show "No classes". The Jakarta timezone note appears once.
 */
export function formatWeek(entriesByDate: ReadonlyMap<string, ScheduleEntry[]>): string {
  const sections = [...entriesByDate.entries()].map(([date, entries]) => {
    const label = labelForDate(date, "Asia/Makassar");
    const body = entries.length === 0
      ? "😴 No classes"
      : entries.map(renderEntry).join("\n\n");
    return `<b>${label}</b>\n${body}`;
  });

  let text = `📅 <b>Weekly schedule</b>\n\n`;
  text += sections.join("\n\n");
  text += `\n\n🕐 Times shown in Jakarta time (WIB, UTC+7)\n`;
  text += `\n<i>Ngobrol Yuk Schedule</i>`;
  return text;
}

function escapeHtml(text: string): string {
  const map: Record<string, string> = {
    "&": "\u0026amp;",
    "<": "\u0026lt;",
    ">": "\u0026gt;",
    '"': "\u0026quot;",
    "'": "\u0026#039;",
  };
  return text.replace(/[&<>"']/g, (match) => map[match] || match);
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
  const args = parseArgs(process.argv.slice(2));

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

  void dispatch(args, services).then((code) => {
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
