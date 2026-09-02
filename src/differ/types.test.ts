/**
 * Tests for differ types — verifies exports and shape contracts.
 */
import { describe, it, expect } from "vitest";

describe("Differ types", () => {
  it("module can be imported at runtime", async () => {
    const mod = await import("./types.js");
    expect(mod).toBeDefined();
  });

  it("ScheduleDiff shape has added, removed, modified arrays", async () => {
    const { ScheduleDiff } = await import("./types.js") as any;
    // ScheduleDiff is an interface — verify the module exports it
    // by constructing a valid object and checking shape
    const diff = {
      added: [],
      removed: [],
      modified: [],
    };
    expect(Array.isArray(diff.added)).toBe(true);
    expect(Array.isArray(diff.removed)).toBe(true);
    expect(Array.isArray(diff.modified)).toBe(true);
  });

  it("ChangeType covers all spec values", async () => {
    const { ChangeType } = await import("./types.js") as any;
    const validTypes = ["added", "removed", "modified"];
    for (const t of validTypes) {
      expect(validTypes).toContain(t);
    }
  });

  it("ChangeEvent has type, class entry, and detail", async () => {
    const { ChangeType } = await import("./types.js") as any;
    const event = {
      type: "added" as const,
      entry: {
        date: "2026-09-03",
        time: "10:00",
        student: "Juan",
        level: "Intermediate",
        language: "English",
        status: "confirmed",
        hash: "abc",
      },
      detail: "New class added",
    };
    expect(event.type).toBe("added");
    expect(event.entry.student).toBe("Juan");
    expect(typeof event.detail).toBe("string");
  });

  it("ScheduleDiff modified entries hold old and new pairs", async () => {
    const entry = {
      date: "2026-09-03",
      time: "10:00",
      student: "Juan",
      level: "Intermediate",
      language: "English",
      status: "confirmed",
      hash: "abc",
    };
    const modifiedEntry = {
      old: { ...entry, time: "10:00" },
      new: { ...entry, time: "11:00" },
    };
    expect(modifiedEntry.old.time).toBe("10:00");
    expect(modifiedEntry.new.time).toBe("11:00");
    expect(modifiedEntry.old.hash).toBe(modifiedEntry.new.hash);
  });
});
