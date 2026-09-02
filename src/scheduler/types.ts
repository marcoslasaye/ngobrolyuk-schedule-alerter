/**
 * Scheduler types — cache persistence and poll cycle contracts.
 *
 * CacheSchema is the JSON persisted between polls at ~/.schedule-cache/.
 * PollResult reports one poll cycle for a single date.
 */
import type { ScheduleEntry } from "../fetcher/types.js";

/** Persisted cache state between poll cycles. */
export interface CacheSchema {
  /** ISO-8601 UTC timestamp of the last successful fetch */
  lastFetch: string;
  /** All schedule entries fetched in the last poll */
  entries: ScheduleEntry[];
  /** Optional HTTP etag for change detection optimisation */
  etag?: string;
}

/** Result of polling one date in a cycle. */
export interface PollResult {
  /** The date that was polled (YYYY-MM-DD) */
  date: string;
  /** Entries parsed for that date */
  entries: ScheduleEntry[];
  /** Number of changes detected for this date */
  changed: number;
  /** Error message if the poll for this date failed, else null */
  error: string | null;
}
