/**
 * Tests for the differ engine — identity-based schedule change detection.
 *
 * Covers: no change, added, removed, modified, reorder-insensitivity, and
 * first-run handling. All comparisons are identity-based (by `hash`), so
 * reordering never triggers a change.
 */
import { describe, it, expect } from "vitest";
import { diffEntries, type DiffResult } from "./engine.js";
import type { ScheduleEntry } from "../fetcher/types.js";

/** Minimal helper to build a ScheduleEntry for tests. */
function entry(
  hash: string,
  overrides: Partial<ScheduleEntry> = {},
): ScheduleEntry {
  return {
    date: "2026-09-03",
    time: "10:00",
    student: "Student",
    level: "Beginner",
    language: "English",
    status: "confirmed",
    hash,
    ...overrides,
  };
}

describe("diffEntries", () => {
  it("returns no changes when both sides are identical (same order)", () => {
    const a = entry("h1", { student: "Juan" });
    const b = entry("h2", { student: "Ana", time: "11:00" });
    const res = diffEntries([a, b], [a, b]);
    expect(res.firstRun).toBe(false);
    expect(res.diff.added).toEqual([]);
    expect(res.diff.removed).toEqual([]);
    expect(res.diff.modified).toEqual([]);
  });

  it("detects an added entry present only in current", () => {
    const cached = entry("h1", { student: "Juan" });
    const fresh = [
      entry("h1", { student: "Juan" }),
      entry("h2", { student: "Ana", time: "11:00" }),
    ];
    const res = diffEntries([cached], fresh);
    expect(res.diff.added).toHaveLength(1);
    expect(res.diff.added[0].hash).toBe("h2");
    expect(res.diff.removed).toEqual([]);
    expect(res.diff.modified).toEqual([]);
  });

  it("detects a removed entry present only in cache", () => {
    const cached = [
      entry("h1", { student: "Juan" }),
      entry("h2", { student: "Ana", time: "11:00" }),
    ];
    const fresh = [entry("h1", { student: "Juan" })];
    const res = diffEntries(cached, fresh);
    expect(res.diff.removed).toHaveLength(1);
    expect(res.diff.removed[0].hash).toBe("h2");
    expect(res.diff.added).toEqual([]);
    expect(res.diff.modified).toEqual([]);
  });

  it("detects a modified entry when mutable fields differ", () => {
    const cached = entry("h1", { student: "Juan", time: "10:00", status: "confirmed" });
    const fresh = entry("h1", { student: "Juan", time: "11:00", status: "pending" });
    const res = diffEntries([cached], [fresh]);
    expect(res.diff.modified).toHaveLength(1);
    expect(res.diff.modified[0].old.time).toBe("10:00");
    expect(res.diff.modified[0].new.time).toBe("11:00");
    expect(res.diff.modified[0].new.status).toBe("pending");
    expect(res.diff.added).toEqual([]);
    expect(res.diff.removed).toEqual([]);
  });

  it("ignores reordering and produces no changes", () => {
    const a = entry("h1", { student: "Juan" });
    const b = entry("h2", { student: "Ana", time: "11:00" });
    const c = entry("h3", { student: "Lucia", time: "12:00", status: "pending" });
    // Same set, different order.
    const res = diffEntries([a, b, c], [c, a, b]);
    expect(res.diff.added).toEqual([]);
    expect(res.diff.removed).toEqual([]);
    expect(res.diff.modified).toEqual([]);
    expect(res.firstRun).toBe(false);
  });

  it("treats an empty cache as first run and marks every current entry added", () => {
    const current = [
      entry("h1", { student: "Juan" }),
      entry("h2", { student: "Ana", time: "11:00" }),
    ];
    const res = diffEntries([], current);
    expect(res.firstRun).toBe(true);
    expect(res.diff.added).toHaveLength(2);
    expect(res.diff.removed).toEqual([]);
    expect(res.diff.modified).toEqual([]);
  });

  it("does not flag a different identity as modified (it is added + removed)", () => {
    // A changed student name changes the hash → not a modification.
    const cached = entry("h1", { student: "Juan", time: "10:00" });
    const fresh = entry("h9", { student: "Juanito", time: "10:00" });
    const res = diffEntries([cached], [fresh]);
    expect(res.diff.modified).toEqual([]);
    expect(res.diff.removed).toHaveLength(1);
    expect(res.diff.added).toHaveLength(1);
  });
});
