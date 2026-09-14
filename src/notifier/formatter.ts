/**
 * Notifier alert formatter — ChangeSummary[] → alert text.
 *
 * Produces a single simple alert: a header plus a "check your schedule"
 * hint, rendered identically for every recipient. The detailed diff is
 * intentionally NOT included — the user wants a clean notification that
 * points them to /today for the details. Because alerts are scoped per
 * user (Phase 4: only TODAY/TOMORROW changes of the user's tutor), no
 * tutor name or date appears in the message itself.
 * An empty change list produces an empty string (caller sends nothing).
 */
import type { AlertPayload, ChangeSummary } from "./types.js";

/** Message header for every change alert. */
export const ALERT_HEADER = "🔔 Schedule changes";

/** Hint appended so the user knows where to see the updated schedule. */
export const ALERT_HINT = "Check your schedule with /today";

/** Timezone note appended to every alert so class times are unambiguous. */
export const TIMEZONE_NOTE = "🕐 Times shown in Jakarta time (WIB, UTC+7)";

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
  return [ALERT_HEADER, "", ALERT_HINT].join("\n");
}

/** FormatterPort interface — satisfies the design's notifier port contract. */
export interface FormatterPort {
  format(payload: AlertPayload): string;
}

export default formatAlert;
