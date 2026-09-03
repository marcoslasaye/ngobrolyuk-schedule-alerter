/**
 * Tests for the notifier alert formatter.
 *
 * Converts ChangeSummary[] / AlertPayload into a human-readable WhatsApp
 * message (summary only — never the full diff). Verifies the spec's message
 * shape: header + one line per change with student, date (Sep 5) and time.
 */
import { describe, it, expect } from "vitest";
import { formatAlert, type FormatterPort } from "./formatter.js";
import type { AlertPayload, ChangeSummary } from "./types.js";
import type { ScheduleEntry } from "../fetcher/types.js";

function entry(overrides: Partial<ScheduleEntry> = {}): ScheduleEntry {
  return {
    date: "2026-09-05",
    time: "10:00",
    student: "Juan Pérez",
    level: "Intermediate",
    language: "English",
    status: "confirmed",
    hash: "h1",
    ...overrides,
  };
}

function summary(
  type: ChangeSummary["type"],
  classEntry: ScheduleEntry,
  detail: string,
): ChangeSummary {
  return { type, class: classEntry, detail };
}

function payload(changes: ChangeSummary[]): AlertPayload {
  return {
    changes,
    timestamp: "2026-09-03T10:00:00.000Z",
    dateRange: { start: "2026-09-03", end: "2026-09-09" },
  };
}

describe("formatAlert", () => {
  it("returns an empty string for an empty change list", () => {
    const text = formatAlert(payload([]));
    expect(text).toBe("");
  });

  it("formats a single added change with student, date, and time", () => {
    const text = formatAlert(
      payload([summary("added", entry(), "New class")]),
    );
    expect(text).toContain("📅 Schedule Change Alert");
    expect(text).toContain("➕ Added");
    expect(text).toContain("Juan Pérez");
    expect(text).toContain("Sep 5");
    expect(text).toContain("10:00");
  });

  it("does not include level or status in the message", () => {
    const text = formatAlert(
      payload([
        summary(
          "added",
          entry({ level: "Intermediate", status: "pending" }),
          "New class",
        ),
      ]),
    );
    expect(text).not.toContain("Intermediate");
    expect(text).not.toContain("pending");
  });

  it("batches multiple changes into a single message", () => {
    const changes = [
      summary("added", entry({ student: "Juan", time: "10:00" }), "New"),
      summary(
        "removed",
        entry({ student: "Ana", date: "2026-09-07", time: "14:00" }),
        "Cancel",
      ),
      summary(
        "modified",
        entry({ student: "Lucia", date: "2026-09-03", time: "09:00" }),
        "Moved",
      ),
    ];
    const text = formatAlert(payload(changes));
    expect(text).toContain("➕ Added");
    expect(text).toContain("Juan");
    expect(text).toContain("➖ Removed");
    expect(text).toContain("Ana");
    expect(text).toContain("Sep 7");
    expect(text).toContain("14:00");
    expect(text).toContain("✏️ Modified");
    expect(text).toContain("Lucia");
    expect(text).toContain("Sep 3");
    expect(text).toContain("09:00");
    // One message header only.
    expect(text.split("📅 Schedule Change Alert").length - 1).toBe(1);
  });
});
