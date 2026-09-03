/**
 * Differ engine — identity-based schedule change detection.
 *
 * Compares two ScheduleEntry[] arrays by their SHA-256 identity `hash`
 * (student + language + date). Reordering never triggers a change because
 * comparison is by hash, not position. An empty cache is treated as a first
 * run: every current entry is reported as `added` and `firstRun` is true so
 * the caller can suppress the alert.
 */
import type { ScheduleEntry } from "../fetcher/types.js";
import type { ScheduleDiff } from "./types.js";

/** Result of diffing two schedule snapshots. */
export interface DiffResult {
  /**
   * True when the cache had no entries (first run). Callers SHOULD suppress
   * the alert in this case — everything is "new", not a real change.
   */
  firstRun: boolean;
  /** The detected change sets. */
  diff: ScheduleDiff;
}

/**
 * Fields that define an entry's identity (these may NEVER be treated as a
 * modification, only as an add/remove pair when they change).
 */
const IDENTITY_FIELDS = new Set<keyof ScheduleEntry>([
  "date",
  "student",
  "language",
  "hash",
  "rawHtml",
]);

/**
 * True when two entries share an identity but differ in a mutable field.
 * Only mutable fields (time, level, status, ...) count as modifications.
 */
function isModified(cached: ScheduleEntry, current: ScheduleEntry): boolean {
  const keys = Object.keys(current) as (keyof ScheduleEntry)[];
  for (const key of keys) {
    if (IDENTITY_FIELDS.has(key)) {
      continue;
    }
    if (cached[key] !== current[key]) {
      return true;
    }
  }
  return false;
}

/**
 * Compute the difference between a cached snapshot and the current one.
 *
 * - `added`: hash in current but not in cache
 * - `removed`: hash in cache but not in current
 * - `modified`: hash in both, but a mutable field differs
 *
 * Worst-case O(n*m); schedule sizes are tiny (tens of entries), so this is
 * fine for the project's scale.
 */
export function diffEntries(
  cached: ScheduleEntry[],
  current: ScheduleEntry[],
): DiffResult {
  const cachedByHash = new Map(cached.map((e) => [e.hash, e]));
  const currentByHash = new Map(current.map((e) => [e.hash, e]));

  const added: ScheduleEntry[] = [];
  const removed: ScheduleEntry[] = [];
  const modified: { old: ScheduleEntry; new: ScheduleEntry }[] = [];

  for (const entry of current) {
    if (!cachedByHash.has(entry.hash)) {
      added.push(entry);
    }
  }

  for (const entry of cached) {
    if (!currentByHash.has(entry.hash)) {
      removed.push(entry);
    } else {
      const currentEntry = currentByHash.get(entry.hash)!;
      if (isModified(entry, currentEntry)) {
        modified.push({ old: entry, new: currentEntry });
      }
    }
  }

  return {
    firstRun: cached.length === 0,
    diff: { added, removed, modified },
  };
}

/**
 * DifferPort interface — satisfies the design's port contract.
 * Composes the raw arrays into a DiffResult.
 */
export interface DifferPort {
  diff(old: ScheduleEntry[], current: ScheduleEntry[]): DiffResult;
}

export default diffEntries;
