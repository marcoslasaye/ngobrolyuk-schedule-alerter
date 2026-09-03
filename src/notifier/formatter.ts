/**
 * Notifier alert formatter — ChangeSummary[] → WhatsApp text.
 *
 * Produces a single human-readable WhatsApp message (summary only; the full
 * diff is never included, per the user's decision). Header + one line per
 * change. Includes student, date (e.g. "Sep 5") and time; never level/status.
 * An empty change list produces an empty string (caller sends nothing).
 */
import type { AlertPayload, ChangeSummary } from "./types.js";

/** Message header for every change alert. */
export const ALERT_HEADER = "📅 Schedule Change Alert";

/** Emoji/label per change type, matching the spec's message shape. */
const CHANGE_LABEL: Record<ChangeSummary["type"], string> = {
  added: "➕ Added",
  removed: "➖ Removed",
  modified: "✏️ Modified",
};

/** English month abbreviations indexed by month number (1-12). */
const MONTH_ABBR = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/**
 * Convert a YYYY-MM-DD date string into a compact "Sep 5" label.
 * Falls back to the raw date string if it cannot be parsed.
 */
export function formatDate(dateStr: string): string {
  const [year, month, day] = dateStr.split("-").map(Number);
  if (!year || !month || !day || month < 1 || month > 12) {
    return dateStr;
  }
  return `${MONTH_ABBR[month - 1]} ${day}`;
}

/** Render a single change summary as one message line. */
function formatLine(change: ChangeSummary): string {
  const { student } = change.class;
  const date = formatDate(change.class.date);
  return `[${CHANGE_LABEL[change.type]}] ${student} — ${date}, ${change.class.time}`;
}

/**
 * Format an AlertPayload as the WhatsApp message text.
 * Returns "" when there are no changes (caller sends no message).
 */
export function formatAlert(payload: AlertPayload): string {
  if (payload.changes.length === 0) {
    return "";
  }
  const lines = payload.changes.map(formatLine);
  return [ALERT_HEADER, ...lines].join("\n");
}

/** FormatterPort interface — satisfies the design's notifier port contract. */
export interface FormatterPort {
  format(payload: AlertPayload): string;
}

export default formatAlert;
