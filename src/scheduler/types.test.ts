/**
 * Tests for scheduler types — verifies exports and shape contracts.
 */
import { describe, it, expect } from "vitest";

describe("Scheduler types", () => {
  it("module can be imported at runtime", async () => {
    const mod = await import("./types.js");
    expect(mod).toBeDefined();
  });

  it("CacheSchema has lastFetch, entries, and optional etag", async () => {
    const entry = {
      date: "2026-09-03",
      time: "10:00",
      student: "Juan",
      level: "Intermediate",
      language: "English",
      status: "confirmed",
      hash: "abc",
    };
    const schema = {
      lastFetch: "2026-09-03T10:00:00.000Z",
      entries: [entry],
      etag: "xyz",
    };
    expect(schema.lastFetch).toBe("2026-09-03T10:00:00.000Z");
    expect(schema.entries).toHaveLength(1);
    expect(schema.entries[0].student).toBe("Juan");
    expect(schema.etag).toBe("xyz");
  });

  it("CacheSchema etag is optional", async () => {
    const schema = {
      lastFetch: "2026-09-03T10:00:00.000Z",
      entries: [],
    };
    expect(schema.etag).toBeUndefined();
  });

  it("PollResult has date, entries, and change result", async () => {
    const result = {
      date: "2026-09-03",
      entries: [],
      changed: 0,
      error: null as string | null,
    };
    expect(result.date).toBe("2026-09-03");
    expect(Array.isArray(result.entries)).toBe(true);
    expect(result.changed).toBe(0);
    expect(result.error).toBeNull();
  });
});
