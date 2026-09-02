/**
 * Notifier types — alert payload and delivery contracts.
 *
 * AlertPayload is what the notifier receives; the formatter converts it
 * to a WhatsApp text message.
 * ChangeSummary summarizes one schedule change for human/message output.
 * DeliveryResult reports whether a delivery attempt succeeded.
 */
import type { ScheduleEntry } from "../fetcher/types.js";
import type { ChangeType } from "../differ/types.js";

/** Summary of a single schedule change for message formatting. */
export interface ChangeSummary {
  /** Type of change: added | removed | modified */
  type: ChangeType;
  /** The affected class entry */
  class: ScheduleEntry;
  /** Human-readable one-line summary */
  detail: string;
}

/** Payload delivered to the notifier for one alert cycle. */
export interface AlertPayload {
  /** List of changes to report (empty = no alert sent) */
  changes: ChangeSummary[];
  /** ISO-8601 UTC timestamp of when the alert was generated */
  timestamp: string;
  /** Date range the fetched schedule covers */
  dateRange: { start: string; end: string };
}

/** Result of attempting to deliver an alert through a channel. */
export interface DeliveryResult {
  /** Whether the delivery succeeded */
  success: boolean;
  /** Delivery channel used: whatsapp | email | telegram | file */
  channel: string;
  /** Error message when success is false */
  error?: string;
}
