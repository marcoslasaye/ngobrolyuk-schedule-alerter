/**
 * Fetcher parser — Cheerio HTML → ScheduleEntry[].
 *
 * Extracts class entries from the raw HTML returned by the WP AJAX
 * endpoint. Empty or selector-mismatched HTML is treated as "no entries"
 * for the date: the function returns [] and logs a warning, never throws.
 *
 * Each entry's identity `hash` is a SHA-256 of `student + language + date`
 * (matching the differ's identity scheme, so reordering never changes it).
 */
import { createHash } from "node:crypto";
import { load } from "cheerio";
import type { ScheduleEntry } from "./types.js";

/**
 * Selector for a single schedule row/entry in the response HTML.
 * See __fixtures__/fetcher/schedule-single-day.html for the recorded shape.
 */
const ENTRY_SELECTOR = "tr.fh-schedule-entry";
const FIELD_SELECTOR = {
  time: ".fh-time",
  student: ".fh-student",
  language: ".fh-language",
  level: ".fh-level",
  status: ".fh-status",
} as const;

/** Empty result reused when no entries can be extracted. */
function noEntries(): ScheduleEntry[] {
  return [];
}

/**
 * Compute the SHA-256 identity hash for a class entry.
 * Deterministic given the same (student, language, date).
 */
export function computeHash(student: string, language: string, date: string): string {
  const payload = [student, language, date].join("");
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

/**
 * Parse raw schedule HTML into structured ScheduleEntry[] records.
 *
 * - No matching rows → returns [] (logs a warning; never throws).
 * - Empty / malformed HTML → returns [].
 * - Rows present → each becomes a ScheduleEntry with a computed hash.
 *
 * The `date` parameter is applied to every entry (YYYY-MM-DD); if omitted
 * the entry carries an empty date string.
 */
export function parseSchedule(html: string, date = ""): ScheduleEntry[] {
  const $ = load(html);
  const rows = $(ENTRY_SELECTOR).toArray();

  if (rows.length === 0) {
    if (html.trim().length > 0) {
      console.warn(
        "[fetcher] No schedule entries found for date " +
          (date || "unknown") +
          " (selector mismatch or empty response).",
      );
    }
    return noEntries();
  }

  const entries: ScheduleEntry[] = [];

  for (const row of rows) {
    const $row = $(row);
    const time = ($row.find(FIELD_SELECTOR.time).text() ?? "").trim();
    const student = ($row.find(FIELD_SELECTOR.student).text() ?? "").trim();
    const language = ($row.find(FIELD_SELECTOR.language).text() ?? "").trim();
    const level = ($row.find(FIELD_SELECTOR.level).text() ?? "").trim();
    const status = ($row.find(FIELD_SELECTOR.status).text() ?? "").trim();

    if (!student) {
      // A row with no student is not a usable schedule entry.
      continue;
    }

    const hash = computeHash(student, language, date);
    entries.push({
      date,
      time,
      student,
      level,
      language,
      status,
      hash,
    });
  }

  return entries;
}
