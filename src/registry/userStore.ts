/**
 * UserStore — JSON file persistence for registered bot users.
 *
 * Every bot user maps their Telegram chatId to the tutor name they care
 * about. The store lives at `~/.schedule-alerter/users.json` (same home-dir
 * pattern as the schedule cache). Writes are atomic — the file is written
 * to `<file>.tmp` first and then renamed over the target — so a crash
 * mid-write never leaves a truncated file. Reads tolerate a missing file
 * (first run) and corrupt/invalid JSON (starting empty, never crashing).
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** A registered bot user: chatId → tutor name (+ tz for date resolution). */
export interface UserRecord {
  /** Telegram chat id, string to keep it simple. */
  chatId: string;
  /** Exact tutor name as it appears in the HTML. */
  tutorName: string;
  /** IANA timezone, e.g. "Asia/Makassar". */
  tz: string;
  /** ISO timestamp of the registration. */
  registeredAt: string;
}

/** Shape of the persisted JSON file. */
interface UserStoreFile {
  users: UserRecord[];
}

/** Temp file suffix used for the atomic write pattern. */
const TMP_SUFFIX = ".tmp";

/**
 * JSON-file-backed registry of registered bot users.
 *
 * `load()` is idempotent and memoized: reads (findByChatId/all) and writes
 * (upsert) all await the same single load promise, so it is safe to call
 * load() once at startup and/or let any later call re-ensure it.
 */
export class UserStore {
  private readonly filePath: string;
  private users: UserRecord[] = [];
  private loadPromise: Promise<void> | null = null;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  /** Load users from disk (or empty if missing). Call before reads. */
  load(): Promise<void> {
    this.loadPromise = this.loadPromise ?? this.readFromDisk();
    return this.loadPromise;
  }

  /** Find by chatId; undefined when not registered. */
  async findByChatId(chatId: string): Promise<UserRecord | undefined> {
    await this.load();
    return this.users.find((u) => u.chatId === chatId);
  }

  /** Register (upsert by chatId). Persists atomically (write temp + rename). */
  async upsert(user: UserRecord): Promise<void> {
    await this.load();
    const existing = this.users.findIndex((u) => u.chatId === user.chatId);
    if (existing >= 0) {
      this.users[existing] = user;
    } else {
      this.users.push(user);
    }
    await this.persist();
  }

  /** All registered users. */
  async all(): Promise<UserRecord[]> {
    await this.load();
    return [...this.users];
  }

  /** Read the JSON file; missing/corrupt → start empty, never crash. */
  private async readFromDisk(): Promise<void> {
    if (!existsSync(this.filePath)) {
      this.users = [];
      return;
    }
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<UserStoreFile>;
      if (!parsed || !Array.isArray(parsed.users)) {
        console.warn(
          `[registry] User store at ${this.filePath} has an unexpected shape; treating as empty.`,
        );
        this.users = [];
        return;
      }
      this.users = parsed.users;
    } catch {
      console.warn(
        `[registry] User store at ${this.filePath} is corrupt (invalid JSON); treating as empty.`,
      );
      this.users = [];
    }
  }

  /** Atomic write: write the temp file, then rename over the target. */
  private async persist(): Promise<void> {
    const tmpPath = `${this.filePath}${TMP_SUFFIX}`;
    await mkdir(dirname(this.filePath), { recursive: true });
    const json = JSON.stringify({ users: this.users }, null, 2);
    await writeFile(tmpPath, json, "utf8");
    await rename(tmpPath, this.filePath);
  }
}