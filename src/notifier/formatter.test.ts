/**
 * Tests for the notifier alert formatter.
 *
 * Converts ChangeSummary[] / AlertPayload into a simple alert message:
 * header + "check your schedule" hint. The detailed diff is intentionally
 * NOT included — the user wants a clean notification that points to /hoy.
 * An empty change list produces an empty string (caller sends nothing).
 */
import { describe, it, expect } from "vitest";
import { formatAlert, ALERT_HEADER, ALERT_HINT, type FormatterPort } from "./formatter.js";
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

  it("renders the simple alert header and hint", () => {
    const text = formatAlert(
      payload([summary("added", entry(), "New class")]),
    );
    expect(text).toContain(ALERT_HEADER);
    expect(text).toContain(ALERT_HINT);
    expect(text).toContain("/hoy");
  });

  it("does not include the detailed diff (student, date, time)", () => {
    const text = formatAlert(
      payload([
        summary(
          "added",
          entry({ level: "Intermediate", status: "pending" }),
          "New class",
        ),
      ]),
    );
    expect(text).not.toContain("Juan Pérez");
    expect(text).not.toContain("Sep");
    expect(text).not.toContain("10:00");
    expect(text).not.toContain("Intermediate");
    expect(text).not.toContain("pending");
  });

  it("renders the same simple message regardless of change count", () => {
    const one = formatAlert(
      payload([summary("added", entry(), "New")]),
    );
    const many = formatAlert(
      payload([
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
      ]),
    );
    expect(one).toBe(many);
    // One header only.
    expect(one.split(ALERT_HEADER).length - 1).toBe(1);
  });
});