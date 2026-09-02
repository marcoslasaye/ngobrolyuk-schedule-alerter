/**
 * Tests for notifier types — verifies exports and shape contracts.
 */
import { describe, it, expect } from "vitest";

describe("Notifier types", () => {
  it("module can be imported at runtime", async () => {
    const mod = await import("./types.js");
    expect(mod).toBeDefined();
  });

  it("AlertPayload has changes, timestamp, and dateRange", async () => {
    const payload = {
      changes: [],
      timestamp: "2026-09-03T10:00:00.000Z",
      dateRange: { start: "2026-09-03", end: "2026-09-09" },
    };
    expect(Array.isArray(payload.changes)).toBe(true);
    expect(typeof payload.timestamp).toBe("string");
    expect(payload.dateRange.start).toBe("2026-09-03");
    expect(payload.dateRange.end).toBe("2026-09-09");
  });

  it("ChangeSummary has type, class, and detail", async () => {
    const summary = {
      type: "added" as const,
      class: {
        date: "2026-09-03",
        time: "10:00",
        student: "Juan",
        level: "Intermediate",
        language: "English",
        status: "confirmed",
        hash: "abc",
      },
      detail: "New class",
    };
    expect(summary.type).toBe("added");
    expect(summary.class.student).toBe("Juan");
    expect(summary.detail).toBe("New class");
  });

  it("DeliveryResult has success status and optional error", async () => {
    const ok: { success: boolean; channel: string; error?: string } = {
      success: true,
      channel: "whatsapp",
    };
    const failed: { success: boolean; channel: string; error?: string } = {
      success: false,
      channel: "whatsapp",
      error: "HTTP 503",
    };
    expect(ok.success).toBe(true);
    expect(ok.error).toBeUndefined();
    expect(failed.success).toBe(false);
    expect(failed.error).toBe("HTTP 503");
  });
});
