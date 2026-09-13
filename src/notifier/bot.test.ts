/**
 * Tests for the Telegram bot listener module.
 *
 * Only pure helpers and construction are covered — no real bot is
 * launched here (no network). The command handler behavior depends on
 * Telegraf's long-polling runtime, which is out of scope for unit tests.
 */
import { describe, it, expect } from "vitest";
import {
  ScheduleBot,
  buildErrorReply,
  buildHelpReply,
  todayDate,
  addDays,
  WEEK_DAYS,
  type ScheduleBotDeps,
} from "./bot.js";
import type { ScheduleEntry } from "../fetcher/types.js";

/** Minimal ScheduleEntry helper for tests. */
function entry(hash: string): ScheduleEntry {
  return {
    date: "2026-09-11",
    time: "10:00",
    tutor: "Marcos Lopez",
    student: "Student",
    level: "Beginner",
    language: "English",
    status: "confirmed",
    hash,
  };
}

/** Dependencies used by the constructor smoke tests (start() never called). */
function mockDeps(): ScheduleBotDeps {
  return {
    tz: "Asia/Makassar",
    fetchByDate: async () => [entry("h1")],
    formatDay: () => "📅 test",
    formatWeek: () => "📅 week",
    labelFor: () => "hoy",
  };
}

describe("buildHelpReply", () => {
  it("returns Spanish help text mentioning all three commands", () => {
    const text = buildHelpReply();
    expect(text).toContain("/horariohoy");
    expect(text).toContain("/manana");
    expect(text).toContain("/semana");
    expect(text).toContain("horario");
  });
});

describe("buildErrorReply", () => {
  it("returns the friendly Spanish error text", () => {
    const text = buildErrorReply();
    expect(text).toContain("No pude obtener el horario");
    expect(text).toContain("Intenta de nuevo en unos minutos");
  });
});

describe("todayDate", () => {
  it("returns YYYY-MM-DD in the given timezone for the injected instant", () => {
    expect(todayDate("Asia/Makassar", new Date("2026-09-11T12:00:00Z"))).toBe(
      "2026-09-11",
    );
  });
});

describe("addDays", () => {
  it("adds days to a YYYY-MM-DD string across month and year boundaries", () => {
    expect(addDays("2026-09-11", 1)).toBe("2026-09-12");
    expect(addDays("2026-09-11", 7)).toBe("2026-09-18");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });
});

describe("WEEK_DAYS", () => {
  it("covers 7 days", () => {
    expect(WEEK_DAYS).toBe(7);
  });
});

describe("ScheduleBot", () => {
  it("constructs with a valid-looking token without launching (no network)", () => {
    const bot = new ScheduleBot("123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11", mockDeps());
    // The internal Telegraf instance is created lazily at construction.
    expect((bot as unknown as { bot: unknown }).bot).toBeDefined();
  });

  it("constructs with the deps object wired to the fields", () => {
    const deps = mockDeps();
    const bot = new ScheduleBot("tok123", deps);
    const internal = bot as unknown as { deps: ScheduleBotDeps };
    expect(internal.deps).toBe(deps);
  });
});