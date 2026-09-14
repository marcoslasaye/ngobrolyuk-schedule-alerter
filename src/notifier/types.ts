/**
 * Notifier types — alert payload and delivery contracts.
 *
 * AlertPayload is what the notifier receives; the formatter converts it
 * to an alert text message.
 * ChangeSummary summarizes one schedule change for human/message output;
 * the embedded `class` entry carries `date` and `tutor`, which the
 * orchestrator uses to route each alert to the right user (Phase 4:
 * alerts fire only for TODAY/TOMORROW changes of the user's tutor).
 * DeliveryResult reports whether a delivery attempt succeeded.
 */
import type { ScheduleEntry } from "../fetcher/types.js";
import type { ChangeType } from "../differ/types.js";

/** Summary of a single schedule change for message formatting. */
export interface ChangeSummary {
  /** Type of change: added | removed | modified */
  type: ChangeType;
  /**
   * The affected class entry. `class.date` (YYYY-MM-DD) and `class.tutor`
   * flow through from the differ and drive per-user alert routing.
   */
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
  /**
   * Telegram chat id of the alert's recipient (per-user alerts). When
   * absent the payload is delivered through the legacy single-recipient
   * channel.
   */
  recipientChatId?: string;
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
