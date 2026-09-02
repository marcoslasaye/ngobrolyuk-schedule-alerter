/**
 * Differ types — schedule change detection contracts.
 *
 * ScheduleDiff is the output of comparing two ScheduleEntry[] arrays.
 * ChangeType is the union of possible change kinds.
 * ChangeEvent wraps a single detected change with context.
 */
import type { ScheduleEntry } from "../fetcher/types.js";

/** Union of possible change types detected by the differ. */
export type ChangeType = "added" | "removed" | "modified";

/** A single detected change event. */
export interface ChangeEvent {
  /** What kind of change this is */
  type: ChangeType;
  /** The ScheduleEntry involved (current for added/modified, cached for removed) */
  entry: ScheduleEntry;
  /** Human-readable description of the change */
  detail: string;
}

/** Result of diffing two ScheduleEntry[] arrays. */
export interface ScheduleDiff {
  /** Entries present in current but not in cache */
  added: ScheduleEntry[];
  /** Entries present in cache but not in current */
  removed: ScheduleEntry[];
  /** Entries with same hash but differing mutable fields */
  modified: { old: ScheduleEntry; new: ScheduleEntry }[];
}
