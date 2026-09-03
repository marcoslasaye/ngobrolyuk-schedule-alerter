/**
 * CachePort — JSON file persistence for schedule state.
 *
 * The cache lives at `~/.schedule-cache/last-schedule.json`. Writes are
 * atomic (write to a temp file, then rename over the target) so a crash
 * mid-write never leaves a truncated file. Reads tolerate a missing file
 * (first run) and corrupt/empty JSON (falling back to first-run behavior).
 */
import {
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { CacheSchema } from "./types.js";

/** Default cache directory name under the user's home directory. */
const DEFAULT_CACHE_DIR = ".schedule-cache";
/** File name of the persisted JSON cache. */
const CACHE_FILE = "last-schedule.json";
/** Temp file suffix used for the atomic write pattern. */
const TMP_SUFFIX = ".tmp";

/**
 * Empty cache used for first run / corruption recovery.
 * `lastFetch` is an empty string to signal "never successfully fetched".
 */
function emptyCache(): CacheSchema {
  return { entries: [], lastFetch: "" };
}

/**
 * Resolve the full path of the cache JSON file.
 * Pass an explicit dir for testing; otherwise defaults to
 * `~/.schedule-cache/last-schedule.json`.
 */
export function cachePathFor(dir?: string): string {
  const base = dir ?? join(homedir(), DEFAULT_CACHE_DIR);
  return join(base, CACHE_FILE);
}

/**
 * Load the persisted cache schema.
 *
 * - No file present        → empty schema (first run)
 * - Invalid JSON / corrupt → empty schema + warning (first-run behavior)
 * - Valid JSON             → parsed schema
 *
 * Never throws. If validation fails on an odd shape, falls back to empty.
 */
export function loadCache(dir?: string): CacheSchema {
  const path = cachePathFor(dir);
  if (!existsSync(path)) {
    return emptyCache();
  }

  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<CacheSchema>;
    if (!parsed || !Array.isArray(parsed.entries)) {
      console.warn(
        `[cache] Cache file at ${path} has an unexpected shape; treating as empty.`,
      );
      return emptyCache();
    }
    return {
      lastFetch: parsed.lastFetch ?? "",
      entries: parsed.entries,
      etag: parsed.etag,
    } as CacheSchema;
  } catch {
    console.warn(
      `[cache] Cache file at ${path} is corrupt (invalid JSON); treating as empty.`,
    );
    return emptyCache();
  }
}

/**
 * Save the cache schema to disk using an atomic write.
 *
 * Writes to `<dir>/last-schedule.json.tmp` first, then renames over the
 * target file. The directory is created if missing. Throws on IO failure
 * (caller decides whether to surface).
 */
export function saveCache(schema: CacheSchema, dir?: string): void {
  const path = cachePathFor(dir);
  const tmpPath = `${path}${TMP_SUFFIX}`;

  // Ensure the directory exists before writing the temp file.
  mkdirSync(dirname(path), { recursive: true });

  const json = JSON.stringify(schema, null, 2);
  writeFileSync(tmpPath, json, "utf8");
  renameSync(tmpPath, path);
}

/**
 * CachePort interface — satisfies the design's port contract.
 */
export interface CachePort {
  load(dir?: string): CacheSchema;
  save(schema: CacheSchema, dir?: string): void;
}
