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
 * Real HTML uses .fh-table-row.fh-item (div-based table, not tr/td).
 */
const ENTRY_SELECTOR = ".fh-table-row.fh-item";
const FIELD_SELECTOR = {
  time: ".fh-cell-waktu .fh-cell-time",
  student: ".fh-cell-siswa",
  language: ".fh-cell-bahasa-wrap .fh-lang-badge",
  level: "", // Not directly available; could infer from language badge
  status: ".fh-cell-status-wrap .fh-status-badge",
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
 * Date is also extracted from the page's date picker (YYYY-MM-DD).
 */
export function parseSchedule(html: string, date = ""): ScheduleEntry[] {
  const $ = load(html);
  const rows = $(ENTRY_SELECTOR).toArray();

  // Extract date from the page's date picker if not provided
  let effectiveDate = date;
  if (!effectiveDate) {
    const pickerVal = $('.fh-date-picker').val();
    if (pickerVal) {
      effectiveDate = pickerVal as string;
    }
  }

  if (rows.length === 0) {
    if (html.trim().length > 0) {
      console.warn(
        "[fetcher] No schedule entries found for date " +
          (effectiveDate || "unknown") +
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
    const status = ($row.find(FIELD_SELECTOR.status).text() ?? "").trim();

    // Extract date from row meta if available (format: "Kam, 03 Sep")
    let rowDate = effectiveDate;
    const rowDateText = $row.find('.fh-cell-date').text().trim();
    if (rowDateText && !effectiveDate) {
      // Could parse Indonesian date format, but we'll use effectiveDate
      // Row date is just for display context
    }

    if (!student) {
      // A row with no student is not a usable schedule entry.
      continue;
    }

    // Level is not directly in HTML; infer from language or leave empty
    const level = "";

    const hash = computeHash(student, language, effectiveDate);
    entries.push({
      date: effectiveDate,
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
