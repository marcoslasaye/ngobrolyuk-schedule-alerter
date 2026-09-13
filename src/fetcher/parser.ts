/**
 * Fetcher parser — Cheerio HTML → ScheduleEntry[].
 *
 * Extracts class entries from the raw HTML returned by the WP AJAX
 * endpoint. Empty or selector-mismatched HTML is treated as "no entries"
 * for the date: the function returns [] and logs a warning, never throws.
 *
 * When `tutors` is provided (non-empty), only rows whose tutor matches one
 * of the given names are returned; when omitted, ALL rows are returned.
 * Identity `hash` is SHA-256 of `tutor + student + language + date`.
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
  tutor: ".fh-cell-tutor .fh-tutor-pill-name",
  language: ".fh-cell-bahasa-wrap .fh-lang-badge",
  level: "",
  status: ".fh-cell-status-wrap .fh-status-badge",
} as const;

/** Empty result reused when no entries can be extracted. */
function noEntries(): ScheduleEntry[] {
  return [];
}

/**
 * Compute the SHA-256 identity hash for a class entry.
 * Deterministic given the same (tutor, student, language, date).
 */
export function computeHash(tutor: string, student: string, language: string, date: string): string {
  const payload = [tutor, student, language, date].join("");
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

/**
 * Parse raw schedule HTML into structured ScheduleEntry[] records.
 *
 * - No matching rows → returns [] (logs a warning; never throws).
 * - Empty / malformed HTML → returns [].
 * - When `tutors` is provided (non-empty) → only rows whose tutor exactly
 *   matches one of the given names (compared after trimming).
 * - When `tutors` is omitted or empty → ALL rows are returned (no tutor filter).
 *
 * The `date` parameter is applied to every entry (YYYY-MM-DD); if omitted
 * the entry carries an empty date string.
 * Date is also extracted from the page's date picker (YYYY-MM-DD).
 */
export function parseSchedule(
  html: string,
  date = "",
  tutors?: string[],
): ScheduleEntry[] {
  const $ = load(html);
  const rows = $(ENTRY_SELECTOR).toArray();

  // Normalize the tutor filter: trimmed, deduplicated, or null when not requested.
  const tutorFilter =
    tutors && tutors.length > 0
      ? new Set(
          tutors
            .map((t) => t.trim())
            .filter((t) => t.length > 0),
        )
      : null;

  // Extract date from the page's date picker if not provided
  let effectiveDate = date;
  if (!effectiveDate) {
    const pickerVal = $(".fh-date-picker").val();
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
    const tutor = ($row.find(FIELD_SELECTOR.tutor).text() ?? "").trim();
    const language = ($row.find(FIELD_SELECTOR.language).text() ?? "").trim();
    const status = ($row.find(FIELD_SELECTOR.status).text() ?? "").trim();

    // When a tutor filter is active, skip rows that do not match.
    if (tutorFilter && !tutorFilter.has(tutor)) {
      continue;
    }

    if (!student) {
      // A row with no student is not a usable schedule entry.
      continue;
    }

    // Level is not directly in HTML; infer from language or leave empty
    const level = "";

    const hash = computeHash(tutor, student, language, effectiveDate);
    entries.push({
      date: effectiveDate,
      time,
      tutor,
      student,
      level,
      language,
      status,
      hash,
    });
  }

  if (entries.length === 0 && rows.length > 0 && tutorFilter) {
    console.info(
      `[fetcher] Found ${rows.length} total classes, but none for the requested tutors on ${effectiveDate}`,
    );
  }

  return entries;
}