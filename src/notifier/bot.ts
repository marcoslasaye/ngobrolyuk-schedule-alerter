/**
 * Telegram bot listener — interactive commands (e.g. /horariohoy).
 *
 * Wraps a Telegraf long-polling instance so the daemon can answer
 * on-demand schedule requests from Telegram. The class owns no process
 * hooks; the caller (orchestrator) controls the bot lifecycle.
 */
import { Telegraf } from "telegraf";
import type { ScheduleEntry } from "../fetcher/types.js";

/** Dependencies injected by the caller (CLI wiring). */
export interface ScheduleBotDeps {
  /** Fetch today's schedule entries (already parsed). */
  fetchToday(): Promise<ScheduleEntry[]>;
  /** Format entries as the Telegram message text. */
  format(entries: ScheduleEntry[]): string;
}

/** Friendly error reply sent when fetching the schedule fails. */
export function buildErrorReply(): string {
  return "❌ No pude obtener el horario. Intenta de nuevo en unos minutos.";
}

/** Short Spanish help text explaining the /horariohoy command. */
export function buildHelpReply(): string {
  return (
    "📅 <b>Ngobrol Yuk Schedule</b>\n\n" +
    "Usa <b>/horariohoy</b> para ver el horario de clases de hoy.\n\n" +
    "<i>Ngobrol Yuk Schedule</i>"
  );
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
        const entries = await this.deps.fetchToday();
        const replyText = this.deps.format(entries);
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