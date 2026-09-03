/**
 * Tests for the notifier quiet-hours queue.
 *
 * Verifies quiet-hours gating (Bali TZ), flushing on window open, per-cycle
 * dedup by hash, and fallback triggering after 3 consecutive WhatsApp
 * failures (with counter reset on fallback recovery).
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

function payload(changes: ChangeSummary[]): AlertPayload {
  return {
    changes,
    timestamp: "2026-09-03T10:00:00.000Z",
    dateRange: { start: "2026-09-03", end: "2026-09-09" },
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
    expect(text).toContain("Juan");
    expect(text).toContain("Ana");
    expect(text).toContain("Lucia");
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
    expect(text.split("Juan").length - 1).toBe(1);
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
