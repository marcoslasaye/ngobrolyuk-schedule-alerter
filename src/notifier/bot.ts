/**
 * Telegram bot listener — interactive commands (e.g. /today, /tomorrow,
 * /week, /register).
 *
 * Wraps a Telegraf long-polling instance so the daemon can answer
 * on-demand schedule requests from Telegram. The class owns no process
 * hooks; the caller (orchestrator) controls the bot lifecycle.
 *
 * Multi-user: every schedule command resolves the requesting chat's
 * registered tutor via `deps.findUser`; unregistered callers are told to
 * use /register first.
 */
import { Telegraf } from "telegraf";
import { formatInTimeZone } from "date-fns-tz";
import type { ScheduleEntry } from "../fetcher/types.js";

/** Number of days covered by the /week command. */
export const WEEK_DAYS = 7;

/**
 * Default timezone applied when a user record has no/invalid tz. The
 * schedule is Jakarta time (WIB, UTC+7), so per-user date resolution
 * (alerts and /today commands) falls back to it consistently.
 */
export const DEFAULT_USER_TZ = "Asia/Jakarta";

/** Dependencies injected by the caller (CLI wiring). */
export interface ScheduleBotDeps {
  /** Owner timezone used to resolve "today" (IANA name, e.g. "Asia/Makassar"). */
  tz: string;
  /** Fetch schedule entries for a specific date (YYYY-MM-DD), optionally for one tutor. */
  fetchByDate(date: string, tutorName?: string): Promise<ScheduleEntry[]>;
  /** Format a single day's entries as the Telegram message (HTML). */
  formatDay(entries: ScheduleEntry[], date: string): string;
  /** Format multiple days' entries keyed by date (YYYY-MM-DD) as a weekly Telegram message (HTML). */
  formatWeek(entriesByDate: ReadonlyMap<string, ScheduleEntry[]>): string;
  /** Human label for a date vs today: "today", "tomorrow", or a weekday + dd/MM label. */
  labelFor(date: string): string;
  /** Resolve the registered user for a chatId (undefined = not registered). */
  findUser(chatId: string): Promise<{ tutorName: string; tz: string } | undefined>;
  /** Register (or re-register) a user for a chatId with their tutor name. */
  registerUser(chatId: string, tutorName: string): Promise<void>;
}

/** Friendly error reply sent when fetching the schedule fails. */
export function buildErrorReply(): string {
  return "❌ Could not fetch the schedule. Try again in a few minutes.";
}

/** Reply sent when the caller is not registered yet. */
export function buildNotRegisteredReply(): string {
  return "❌ You are not registered yet. Use /register <Tutor Name> first.";
}

/** Usage error reply for the /register command (missing tutor argument). */
export function buildRegistrarUsageReply(): string {
  return "Usage: /register <Tutor Name>, e.g. /register Marcos Lopez";
}

/** Short help text explaining the interactive commands. */
export function buildHelpReply(): string {
  return (
    "📅 <b>Ngobrol Yuk Schedule</b>\n\n" +
    "Use <b>/register &lt;Tutor Name&gt;</b> to register your tutor name.\n\n" +
    "Then you can use:\n" +
    "<b>/today</b> — see today's class schedule.\n" +
    "<b>/tomorrow</b> — see tomorrow's class schedule.\n" +
    "<b>/week</b> — see the schedule for the next " +
    `${WEEK_DAYS} days.\n\n` +
    "<i>Ngobrol Yuk Schedule</i>"
  );
}

/**
 * Extract the tutor name from a /register command message.
 * Pure: input is the raw message text; output is the trimmed argument.
 *
 *   "/register Marcos Lopez"        → "Marcos Lopez"
 *   "/register"                     → ""
 *   "/register   Marcos   Lopez  "  → "Marcos Lopez"
 */
export function parseRegisterArgs(text: string): string {
  // Trim first: leading whitespace would otherwise leave an empty first
  // token and `slice(1)` would keep the "/register" command itself.
  return text.trim().split(/\s+/).slice(1).join(" ").trim();
}

/**
 * Today's date string (YYYY-MM-DD) in the given timezone.
 * Pure: `now` is injectable so tests are deterministic.
 */
export function todayDate(tz: string, now: Date = new Date()): string {
  return formatInTimeZone(now, tz, "yyyy-MM-dd");
}

/**
 * Add whole days to a YYYY-MM-DD date string using UTC arithmetic, so the
 * result never shifts across timezone boundaries. Returns YYYY-MM-DD.
 */
export function addDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return formatInTimeZone(shifted, "UTC", "yyyy-MM-dd");
}

/** Escape HTML-special characters for safe rendering in parse_mode HTML. */
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
 * Telegram bot listener for interactive commands.
 *
 * `start()` registers the commands and begins long polling; `stop()`
 * tears the poller down. Handler errors never reach the outer loop —
 * they are caught and answered with a friendly reply.
 */
export class ScheduleBot {
  private readonly bot: Telegraf;
  private readonly deps: ScheduleBotDeps;
  private started = false;

  constructor(botToken: string, deps: ScheduleBotDeps) {
    this.bot = new Telegraf(botToken);
    this.deps = deps;
  }

  /** Register handlers and start long-polling. No-op if already started. */
  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    this.bot.command("today", async (ctx) => {
      try {
        const user = await this.deps.findUser(String(ctx.chat.id));
        if (!user) {
          await ctx.reply(buildNotRegisteredReply());
          return;
        }
        const tz = user.tz?.trim() || DEFAULT_USER_TZ;
        const today = todayDate(tz);
        const entries = await this.deps.fetchByDate(today, user.tutorName);
        const replyText = this.deps.formatDay(entries, today);
        await ctx.reply(replyText, { parse_mode: "HTML" });
      } catch {
        await ctx.reply(buildErrorReply()).catch(() => {
          // Swallow reply failures — never propagate to the outer loop.
        });
      }
    });

    this.bot.command("tomorrow", async (ctx) => {
      try {
        const user = await this.deps.findUser(String(ctx.chat.id));
        if (!user) {
          await ctx.reply(buildNotRegisteredReply());
          return;
        }
        const tz = user.tz?.trim() || DEFAULT_USER_TZ;
        const tomorrow = addDays(todayDate(tz), 1);
        const entries = await this.deps.fetchByDate(tomorrow, user.tutorName);
        const replyText = this.deps.formatDay(entries, tomorrow);
        await ctx.reply(replyText, { parse_mode: "HTML" });
      } catch {
        await ctx.reply(buildErrorReply()).catch(() => {
          // Swallow reply failures — never propagate to the outer loop.
        });
      }
    });

    this.bot.command("week", async (ctx) => {
      try {
        const user = await this.deps.findUser(String(ctx.chat.id));
        if (!user) {
          await ctx.reply(buildNotRegisteredReply());
          return;
        }
        const tz = user.tz?.trim() || DEFAULT_USER_TZ;
        const today = todayDate(tz);
        const days = Array.from(
          { length: WEEK_DAYS },
          (_, i) => addDays(today, i),
        );
        const results = await Promise.allSettled(
          days.map((date) => this.deps.fetchByDate(date, user.tutorName)),
        );
        const entriesByDate = new Map<string, ScheduleEntry[]>();
        const failed: string[] = [];
        results.forEach((result, i) => {
          if (result.status === "fulfilled") {
            entriesByDate.set(days[i], result.value);
          } else {
            // Tolerate per-day failures — note them instead of crashing.
            failed.push(days[i]);
          }
        });

        let replyText = this.deps.formatWeek(entriesByDate);
        if (failed.length > 0) {
          const skipped = failed
            .map((date) => `Could not fetch the schedule for ${this.deps.labelFor(date)}.`)
            .join("\n");
          replyText += `\n\n⚠️ ${skipped}`;
        }
        await ctx.reply(replyText, { parse_mode: "HTML" });
      } catch {
        await ctx.reply(buildErrorReply()).catch(() => {
          // Swallow reply failures — never propagate to the outer loop.
        });
      }
    });

    this.bot.command("register", async (ctx) => {
      try {
        const tutor = parseRegisterArgs(ctx.message?.text ?? "");
        if (!tutor) {
          await ctx.reply(buildRegistrarUsageReply());
          return;
        }
        await this.deps.registerUser(String(ctx.chat.id), tutor);
        await ctx.reply(
          `✅ Registered as <b>${escapeHtml(tutor)}</b>. Use /today to see your schedule.`,
          { parse_mode: "HTML" },
        );
      } catch {
        await ctx.reply(buildErrorReply()).catch(() => {
          // Swallow reply failures — never propagate to the outer loop.
        });
      }
    });

    this.bot.command("start", (ctx) =>
      ctx.reply(buildHelpReply(), { parse_mode: "HTML" }),
    );
    this.bot.command("help", (ctx) =>
      ctx.reply(buildHelpReply(), { parse_mode: "HTML" }),
    );

    try {
      await this.bot.launch();
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`schedule-bot: failed to launch Telegram bot: ${detail}`);
    }
    this.started = true;
  }

  /** Stop the bot poller. */
  async stop(): Promise<void> {
    if (!this.started) {
      return;
    }
    await this.bot.stop();
    this.started = false;
  }
}