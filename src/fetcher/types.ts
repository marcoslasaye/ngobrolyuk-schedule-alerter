/**
 * ScheduleEntry — structured record for a single class slot.
 *
 * Identity is derived from `hash` (SHA-256 of student + language + date).
 * Used across fetcher → differ → notifier pipeline.
 */
export interface ScheduleEntry {
  /** Class date in YYYY-MM-DD format */
  date: string;
  /** Class start time in HH:mm format (Bali time) */
  time: string;
  /** Student / customer name */
  student: string;
  /** Proficiency level, e.g. "Beginner", "Intermediate", "Advanced" */
  level: string;
  /** Language being taught, e.g. "English", "Spanish" */
  language: string;
  /** Booking status: confirmed | pending | cancelled */
  status: string;
  /** Optional raw HTML snippet for debugging / traceability */
  rawHtml?: string;
  /** SHA-256 identity hash: student + language + date */
  hash: string;
}

/**
 * Raw HTML response from the WP AJAX endpoint.
 * The parser extracts ScheduleEntry[] from this.
 */
export interface RawScheduleResponse {
  /** HTTP status code */
  status: number;
  /** Raw HTML body from the AJAX endpoint */
  html: string;
  /** The date this response is for (YYYY-MM-DD) */
  date: string;
}
