/**
 * Tests for the notifier quiet-hours queue.
 *
 * Verifies quiet-hours gating (Bali TZ), flushing on window open, per-cycle
 * dedup by hash, and fallback triggering after 3 consecutive WhatsApp
 * failures (with counter reset on fallback recovery). Phase 4: per-user
 * alerts addressed via `recipientChatId` are delivered to their own chat
 * through `onSendToUser` (grouped per recipient on flush); an un-wired
 * `onSendToUser` skips the group with an error — it never falls through
 * to the legacy `onSend` channel.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { AlertQueue } from "./queue.js";
import type { AlertPayload, ChangeSummary, DeliveryResult } from "./types.js";
import type { ScheduleEntry } from "../fetcher/types.js";

function entry(hash: string, name: string, time = "10:00"): ScheduleEntry {
  return {
    date: "2026-09-05",
    time,
    student: name,
    level: "Beginner",
    language: "English",
    status: "confirmed",
    hash,
  };
}

function change(type: ChangeSummary["type"], e: ScheduleEntry): ChangeSummary {
  return { type, class: e, detail: type };
}

function payload(changes: ChangeSummary[], recipientChatId?: string): AlertPayload {
  return {
    changes,
    timestamp: "2026-09-03T10:00:00.000Z",
    dateRange: { start: "2026-09-03", end: "2026-09-09" },
    recipientChatId,
  };
}

/** Build a Date at the given Bali (Asia/Makassar, UTC+8) wall-clock time. */
function atBaliTime(dayIso: string, hh: number, mm = 0): Date {
  const [y, m, d] = dayIso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, hh - 8, mm));
}

const QUIET = { start: "22:00", end: "06:00", tz: "Asia/Makassar" };

describe("AlertQueue", () => {
  let onSend: ReturnType<typeof vi.fn>;
  let onFallback: ReturnType<typeof vi.fn>;

  function ok(): DeliveryResult {
    return { success: true, channel: "whatsapp" };
  }

  beforeEach(() => {
    onSend = vi.fn().mockResolvedValue(ok());
    onFallback = vi.fn().mockResolvedValue({ success: true, channel: "email" });
  });

  it("queues an alert during quiet hours without sending WhatsApp", async () => {
    const q = new AlertQueue({ ...QUIET, onSend, onFallback });
    const now = atBaliTime("2026-09-03", 23, 30);
    await q.process(payload([change("added", entry("h1", "Juan"))]), now);
    expect(onSend).not.toHaveBeenCalled();
    expect(q.queuedCount).toBe(1);
  });

  it("sends immediately outside quiet hours", async () => {
    const q = new AlertQueue({ ...QUIET, onSend, onFallback });
    const now = atBaliTime("2026-09-03", 14, 0);
    await q.process(payload([change("added", entry("h1", "Juan"))]), now);
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(q.queuedCount).toBe(0);
  });

  it("flushes queued changes as a single message when the window opens", async () => {
    const q = new AlertQueue({ ...QUIET, onSend, onFallback });
    // Queue two changes during quiet hours (two separate cycles).
    await q.process(payload([change("added", entry("h1", "Juan"))]), atBaliTime("2026-09-03", 23, 0));
    await q.process(
      payload([change("removed", entry("h2", "Ana", "11:00"))]),
      atBaliTime("2026-09-03", 23, 30),
    );
    expect(q.queuedCount).toBe(2);
    expect(onSend).not.toHaveBeenCalled();
    // Window opens at 06:00 Bali → next cycle flushes everything.
    await q.process(
      payload([change("modified", entry("h3", "Lucia", "09:00"))]),
      atBaliTime("2026-09-04", 6, 0),
    );
    expect(onSend).toHaveBeenCalledTimes(1);
    const text = onSend.mock.calls[0][0] as string;
    expect(text).toContain("🔔 Schedule changes");
    expect(text).toContain("/today");
    expect(q.queuedCount).toBe(0);
  });

  it("dedups changes with the same hash within one cycle", async () => {
    const q = new AlertQueue({ ...QUIET, onSend, onFallback });
    const now = atBaliTime("2026-09-03", 14, 0);
    await q.process(
      payload([
        change("added", entry("h1", "Juan")),
        change("modified", entry("h1", "Juan")),
      ]),
      now,
    );
    expect(onSend).toHaveBeenCalledTimes(1);
    const text = onSend.mock.calls[0][0] as string;
    // Dedup merged before formatting — the simple alert is identical
    // regardless of how many changes were in the cycle.
    expect(text).toContain("🔔 Schedule changes");
  });

  it("triggers fallback after 3 consecutive WhatsApp failures and resets on success", async () => {
    onSend.mockReset();
    onSend.mockResolvedValue({ success: false, channel: "whatsapp", error: "HTTP 503" });
    const q = new AlertQueue({ ...QUIET, onSend, onFallback });
    const now = atBaliTime("2026-09-03", 14, 0);

    // Failures 1 and 2 → WhatsApp only, no fallback yet.
    await q.process(payload([change("added", entry("h1", "Juan"))]), now);
    await q.process(payload([change("added", entry("h1", "Juan"))]), now);
    expect(onFallback).not.toHaveBeenCalled();
    expect(q.consecutiveFailures).toBe(2);

    // 3rd consecutive failure → fallback triggers and counter resets.
    await q.process(payload([change("added", entry("h1", "Juan"))]), now);
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(q.consecutiveFailures).toBe(0);

    // After fallback recovery, a new WhatsApp failure restarts at 1.
    onSend.mockResolvedValue({ success: false, channel: "whatsapp", error: "HTTP 500" });
    await q.process(payload([change("added", entry("h2", "Ana"))]), now);
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(q.consecutiveFailures).toBe(1);
  });
});

describe("AlertQueue — per-user recipients (Phase 4)", () => {
  let onSend: ReturnType<typeof vi.fn>;
  let onFallback: ReturnType<typeof vi.fn>;
  let onSendToUser: ReturnType<typeof vi.fn>;

  function ok(): DeliveryResult {
    return { success: true, channel: "whatsapp" };
  }

  beforeEach(() => {
    onSend = vi.fn().mockResolvedValue(ok());
    onFallback = vi.fn().mockResolvedValue({ success: true, channel: "email" });
    onSendToUser = vi.fn().mockResolvedValue({ success: true, channel: "telegram" });
  });

  it("delivers a per-user alert to the recipient's own chat via onSendToUser", async () => {
    const q = new AlertQueue({ ...QUIET, onSend, onFallback, onSendToUser });
    const now = atBaliTime("2026-09-03", 14, 0);

    await q.process(payload([change("added", entry("h1", "Juan"))], "chat-42"), now);

    expect(onSend).not.toHaveBeenCalled();
    expect(onSendToUser).toHaveBeenCalledTimes(1);
    const [text, chatId] = onSendToUser.mock.calls[0] as [string, string];
    expect(chatId).toBe("chat-42");
    expect(text).toContain("🔔 Schedule changes");
    expect(text).toContain("/today");
  });

  it("groups pending per-user changes by recipient chat when flushing", async () => {
    const q = new AlertQueue({ ...QUIET, onSend, onFallback, onSendToUser });
    const quietNight = atBaliTime("2026-09-03", 23, 0);

    // Two different users' alerts land during quiet hours.
    await q.process(payload([change("added", entry("h1", "Juan"))], "chatA"), quietNight);
    await q.process(payload([change("added", entry("h2", "Ana"))], "chatB"), quietNight);
    expect(q.queuedCount).toBe(2);
    expect(onSendToUser).not.toHaveBeenCalled();

    // Window opens → flush delivers ONE message per recipient chat.
    await q.flush();
    expect(onSendToUser).toHaveBeenCalledTimes(2);
    const chats = onSendToUser.mock.calls.map((c) => c[1]);
    expect(chats.sort()).toEqual(["chatA", "chatB"]);
    expect(q.queuedCount).toBe(0);
  });

  it("skips per-user alerts when onSendToUser is not wired (never falls through to legacy onSend)", async () => {
    const logger = { error: vi.fn() };
    const q = new AlertQueue({ ...QUIET, onSend, onFallback, logger }); // no onSendToUser
    const now = atBaliTime("2026-09-03", 14, 0);

    await q.process(
      payload(
        [
          change("added", entry("h1", "Juan")),
          change("removed", entry("h2", "Ana", "11:00")),
        ],
        "chat-9",
      ),
      now,
    );

    // The recipient's alert is skipped entirely — it must NOT leak into the
    // legacy WhatsApp chat, and nothing stays queued for it.
    expect(onSend).not.toHaveBeenCalled();
    expect(onFallback).not.toHaveBeenCalled();
    expect(q.queuedCount).toBe(0);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      "queue:onSendToUser not wired; skipping 2 alerts for recipient",
    );
  });

  it("keeps only undelivered recipients pending when another recipient fails", async () => {
    onSendToUser.mockImplementation(async (text: string, chatId: string) => {
      void text;
      return chatId === "bad"
        ? { success: false, channel: "telegram", error: "HTTP 500" }
        : { success: true, channel: "telegram" };
    });
    const q = new AlertQueue({ ...QUIET, onSend, onFallback, onSendToUser });
    const quietNight = atBaliTime("2026-09-03", 23, 0);

    await q.process(payload([change("added", entry("h1", "Juan"))], "good"), quietNight);
    await q.process(payload([change("added", entry("h2", "Ana"))], "bad"), quietNight);
    await q.flush();

    // The good recipient was delivered; the bad one stays queued for retry.
    expect(onSendToUser).toHaveBeenCalledTimes(2);
    expect(q.queuedCount).toBe(1);
  });
});
