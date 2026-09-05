/**
 * Tests for the fetcher parser (Cheerio HTML → ScheduleEntry[]).
 *
 * Uses the recorded fixtures in __fixtures__/fetcher/:
 *  - schedule-single-day.html  → 3 entries
 *  - schedule-empty.html       → 0 entries (no error)
 *  - schedule-malformed.html   → 0 entries (selector mismatch, no error)
 *
 * Also verifies the identity hash (SHA-256 of student+language+date).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSchedule, computeHash } from "./parser.js";

const FIXTURES = join(process.cwd(), "__fixtures__", "fetcher");

describe("computeHash", () => {
  it("is deterministic for identical inputs", () => {
    const a = computeHash("Juan Pérez", "English", "2026-09-03");
    const b = computeHash("Juan Pérez", "English", "2026-09-03");
    expect(a).toBe(b);
  });

  it("differs when student, language, or date changes", () => {
    const base = computeHash("Juan", "English", "2026-09-03");
    expect(computeHash("Ana", "English", "2026-09-03")).not.toBe(base);
    expect(computeHash("Juan", "Spanish", "2026-09-03")).not.toBe(base);
    expect(computeHash("Juan", "English", "2026-09-04")).not.toBe(base);
  });

  it("produces a 64-char hex SHA-256 string", () => {
    expect(computeHash("x", "y", "z")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("parseSchedule", () => {
  it("parses 3 entries from the single-day fixture", () => {
    const html = readFileSync(join(FIXTURES, "schedule-single-day.html"), "utf8");
    const entries = parseSchedule(html, "2026-09-03");
    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({
      date: "2026-09-03",
      time: "09:00 – 10:00",
      student: "Juan Pérez",
      language: "English",
      level: "",
      status: "Selesai",
    });
    expect(entries[1].student).toBe("María García");
    expect(entries[1].language).toBe("Spanish");
    expect(entries[2].student).toBe("Lucía Fernández");
    expect(entries[2].status).toBe("Ditunda");
  });

  it("computes a stable hash for each parsed entry", () => {
    const html = readFileSync(join(FIXTURES, "schedule-single-day.html"), "utf8");
    const entries = parseSchedule(html, "2026-09-03");
    const expected = computeHash("Juan Pérez", "English", "2026-09-03");
    expect(entries[0].hash).toBe(expected);
  });

  it("returns an empty array for the empty fixture (no error)", () => {
    const html = readFileSync(join(FIXTURES, "schedule-empty.html"), "utf8");
    expect(() => parseSchedule(html, "2026-09-03")).not.toThrow();
    expect(parseSchedule(html, "2026-09-03")).toEqual([]);
  });

  it("returns an empty array for malformed HTML without throwing", () => {
    const html = readFileSync(join(FIXTURES, "schedule-malformed.html"), "utf8");
    expect(() => parseSchedule(html, "2026-09-03")).not.toThrow();
    expect(parseSchedule(html, "2026-09-03")).toEqual([]);
  });

  it("returns an empty array for an empty string", () => {
    expect(parseSchedule("", "2026-09-03")).toEqual([]);
  });

  it("applies the given date to every entry", () => {
    const html = readFileSync(join(FIXTURES, "schedule-single-day.html"), "utf8");
    const entries = parseSchedule(html, "2026-09-05");
    expect(entries.every((e) => e.date === "2026-09-05")).toBe(true);
  });

  it("skips a row that has no student name", () => {
    const html = `
      <div class="fh-table-wrap" id="fh-schedule-list">
        <div class="fh-table-row fh-item" data-status="confirmed" role="row">
          <div class="fh-cell-waktu" role="cell">
            <span class="fh-cell-time">09:00 – 10:00</span>
          </div>
          <div class="fh-cell-siswa" role="cell"></div>
          <div class="fh-cell-bahasa-wrap" role="cell">
            <span class="fh-lang-badge fh-lang-english">English</span>
          </div>
          <div class="fh-cell-status-wrap" role="cell">
            <span class="fh-status-badge fh-badge-confirmed">Selesai</span>
          </div>
        </div>
        <div class="fh-table-row fh-item" data-status="confirmed" role="row">
          <div class="fh-cell-waktu" role="cell">
            <span class="fh-cell-time">10:00 – 11:00</span>
          </div>
          <div class="fh-cell-siswa" role="cell">Ana Torres</div>
          <div class="fh-cell-bahasa-wrap" role="cell">
            <span class="fh-lang-badge fh-lang-english">English</span>
          </div>
          <div class="fh-cell-status-wrap" role="cell">
            <span class="fh-status-badge fh-badge-confirmed">Selesai</span>
          </div>
        </div>
      </div>
    `;
    const entries = parseSchedule(html, "2026-09-03");
    expect(entries).toHaveLength(1);
    expect(entries[0].student).toBe("Ana Torres");
  });
});
