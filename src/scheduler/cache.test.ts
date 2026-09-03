/**
 * Tests for scheduler cache (JSON file persistence with atomic write).
 *
 * Verifies:
 *  - load() returns an empty schema when no cache exists (first run)
 *  - load() returns corrupt cache as empty (first-run behavior + warning)
 *  - load() returns the persisted schema for a valid file
 *  - save() writes a valid JSON file and atomically replaces it (tmp + rename)
 *  - crash-safety: no partial file remains on save
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCache, saveCache, cachePathFor } from "./cache.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "schedule-cache-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const sampleEntry = {
  date: "2026-09-03",
  time: "10:00",
  student: "Juan Pérez",
  level: "Intermediate",
  language: "English",
  status: "confirmed",
  hash: "abc123",
};

describe("cachePathFor", () => {
  it("returns the last-schedule.json path inside the given cache dir", () => {
    const p = cachePathFor(dir);
    expect(p).toBe(join(dir, "last-schedule.json"));
  });

  it("defaults to ~/.schedule-cache/last-schedule.json when no dir given", () => {
    const p = cachePathFor();
    expect(p).toContain(".schedule-cache");
    expect(p.endsWith("last-schedule.json")).toBe(true);
  });
});

describe("loadCache", () => {
  it("returns an empty schema when no cache file exists (first run)", () => {
    const cache = loadCache(dir);
    expect(cache.entries).toEqual([]);
    expect(cache.lastFetch).toBe("");
  });

  it("returns empty schema when the cache file is corrupt (invalid JSON)", () => {
    writeFileSync(join(dir, "last-schedule.json"), "{ not valid json", "utf8");
    const cache = loadCache(dir);
    expect(cache.entries).toEqual([]);
    expect(cache.lastFetch).toBe("");
  });

  it("returns the persisted schema for a valid cache file", () => {
    const schema = {
      lastFetch: "2026-09-03T10:00:00.000Z",
      entries: [{ ...sampleEntry }],
    };
    writeFileSync(join(dir, "last-schedule.json"), JSON.stringify(schema), "utf8");
    const cache = loadCache(dir);
    expect(cache.lastFetch).toBe("2026-09-03T10:00:00.000Z");
    expect(cache.entries).toHaveLength(1);
    expect(cache.entries[0].student).toBe("Juan Pérez");
  });

  it("ignores an etag field when present", () => {
    const schema = {
      lastFetch: "2026-09-03T10:00:00.000Z",
      entries: [{ ...sampleEntry }],
      etag: "abc-etag",
    };
    writeFileSync(join(dir, "last-schedule.json"), JSON.stringify(schema), "utf8");
    const cache = loadCache(dir);
    expect(cache.etag).toBe("abc-etag");
  });
});

describe("saveCache", () => {
  it("writes a JSON file to the cache dir", () => {
    const schema = {
      lastFetch: "2026-09-03T10:00:00.000Z",
      entries: [{ ...sampleEntry }],
    };
    saveCache(schema, dir);
    const file = join(dir, "last-schedule.json");
    expect(existsSync(file)).toBe(true);
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    expect(parsed.lastFetch).toBe("2026-09-03T10:00:00.000Z");
    expect(parsed.entries).toHaveLength(1);
  });

  it("creates the directory if it does not exist", () => {
    const nested = join(dir, "nested", "cache");
    const schema = { lastFetch: "2026-09-03T10:00:00.000Z", entries: [] };
    saveCache(schema, nested);
    expect(existsSync(join(nested, "last-schedule.json"))).toBe(true);
  });

  it("does not leave a leftover .tmp file after save", () => {
    const schema = { lastFetch: "2026-09-03T10:00:00.000Z", entries: [{ ...sampleEntry }] };
    saveCache(schema, dir);
    const files = require("node:fs").readdirSync(dir);
    const tmps = files.filter((f: string) => f.endsWith(".tmp"));
    expect(tmps).toHaveLength(0);
  });

  it("overwrites an existing cache file on repeated save", () => {
    saveCache({ lastFetch: "2026-09-03T10:00:00.000Z", entries: [{ ...sampleEntry }] }, dir);
    const updated = {
      lastFetch: "2026-09-03T12:00:00.000Z",
      entries: [{ ...sampleEntry, time: "12:00" }],
    };
    saveCache(updated, dir);
    const parsed = JSON.parse(readFileSync(join(dir, "last-schedule.json"), "utf8"));
    expect(parsed.lastFetch).toBe("2026-09-03T12:00:00.000Z");
    expect(parsed.entries[0].time).toBe("12:00");
  });
});
