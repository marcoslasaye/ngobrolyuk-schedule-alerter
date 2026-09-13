/**
 * Telegram bot listener — interactive commands (e.g. /horariohoy, /manana).
 *
 * Wraps a Telegraf long-polling instance so the daemon can answer
 * on-demand schedule requests from Telegram. The class owns no process
 * hooks; the caller (orchestrator) controls the bot lifecycle.
 */
import { Telegraf } from "telegraf";
import { formatInTimeZone } from "date-fns-tz";
import type { ScheduleEntry } from "../fetcher/types.js";

/** Number of days covered by the /semana command. */
export const WEEK_DAYS = 7;

/** Dependencies injected by the caller (CLI wiring). */
export interface ScheduleBotDeps {
  /** Owner timezone used to resolve "today" (IANA name, e.g. "Asia/Makassar"). */
  tz: string;
  /** Fetch schedule entries for a specific date (YYYY-MM-DD). */
  fetchByDate(date: string): Promise<ScheduleEntry[]>;
  /** Format a single day's entries as the Telegram message (HTML). */
  formatDay(entries: ScheduleEntry[], date: string): string;
  /** Format multiple days' entries keyed by date (YYYY-MM-DD) as a weekly Telegram message (HTML). */
  formatWeek(entriesByDate: ReadonlyMap<string, ScheduleEntry[]>): string;
  /** Human label for a date vs today: "hoy", "mañana", or a weekday + dd/MM label. */
  labelFor(date: string): string;
}

/** Friendly error reply sent when fetching the schedule fails. */
export function buildErrorReply(): string {
  return "❌ No pude obtener el horario. Intenta de nuevo en unos minutos.";
}

/** Short Spanish help text explaining the interactive commands. */
export function buildHelpReply(): string {
  return (
    "📅 <b>Ngobrol Yuk Schedule</b>\n\n" +
    "Usa <b>/horariohoy</b> para ver el horario de clases de hoy.\n" +
    "Usa <b>/manana</b> para ver el horario de clases de mañana.\n" +
    "Usa <b>/semana</b> para ver el horario de los próximos " +
    `${WEEK_DAYS} días.\n\n` +
    "<i>Ngobrol Yuk Schedule</i>"
  );
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

    this.bot.command("horariohoy", async (ctx) => {
      try {
        const today = todayDate(this.deps.tz);
        const entries = await this.deps.fetchByDate(today);
        const replyText = this.deps.formatDay(entries, today);
        await ctx.reply(replyText, { parse_mode: "HTML" });
      } catch {
        await ctx.reply(buildErrorReply()).catch(() => {
          // Swallow reply failures — never propagate to the outer loop.
        });
      }
    });

    this.bot.command("manana", async (ctx) => {
      try {
        const tomorrow = addDays(todayDate(this.deps.tz), 1);
        const entries = await this.deps.fetchByDate(tomorrow);
        const replyText = this.deps.formatDay(entries, tomorrow);
        await ctx.reply(replyText, { parse_mode: "HTML" });
      } catch {
        await ctx.reply(buildErrorReply()).catch(() => {
          // Swallow reply failures — never propagate to the outer loop.
        });
      }
    });

    this.bot.command("semana", async (ctx) => {
      try {
        const today = todayDate(this.deps.tz);
        const days = Array.from(
          { length: WEEK_DAYS },
          (_, i) => addDays(today, i),
        );
        const results = await Promise.allSettled(
          days.map((date) => this.deps.fetchByDate(date)),
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
            .map((date) => `No pude obtener el horario del ${this.deps.labelFor(date)}.`)
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