/**
 * Tests for the JSON-file UserStore (user registry).
 *
 * Uses a per-test temp directory (`node:os` tmpdir + mkdtemp) so the tests
 * never touch the real `~/.schedule-alerter/users.json`.
 */
import { describe, it, expect, afterAll } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  existsSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UserStore, type UserRecord } from "./userStore.js";

/** Throwaway temp dirs created by the tests (cleaned up on exit). */
const tempDirs: string[] = [];

/** Create a store pointing at a fresh temp file, and remember the dir. */
function freshStore(): { store: UserStore; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "schedule-users-"));
  tempDirs.push(dir);
  const file = join(dir, "users.json");
  return { store: new UserStore(file), file };
}

/** Minimal UserRecord helper for tests. */
function user(chatId: string, tutorName: string): UserRecord {
  return {
    chatId,
    tutorName,
    tz: "Asia/Makassar",
    registeredAt: "2026-09-13T00:00:00.000Z",
  };
}

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("UserStore", () => {
  it("loads empty when the file is missing", async () => {
    const { store } = freshStore();
    await store.load();
    expect(await store.all()).toEqual([]);
    expect(await store.findByChatId("123")).toBeUndefined();
  });

  it("upserts a user and finds them by chatId", async () => {
    const { store } = freshStore();
    await store.upsert(user("7600140331", "Marcos Lopez"));
    await store.upsert(user("101", "Salma Rizky"));

    const found = await store.findByChatId("7600140331");
    expect(found).toBeDefined();
    expect(found!.tutorName).toBe("Marcos Lopez");
    expect(found!.tz).toBe("Asia/Makassar");
    expect(await store.findByChatId("404")).toBeUndefined();
  });

  it("upsert overwrites an existing chatId instead of duplicating", async () => {
    const { store } = freshStore();
    await store.upsert(user("123", "Marcos Lopez"));
    await store.upsert(user("123", "Salma Rizky"));

    expect(await store.all()).toHaveLength(1);
    expect((await store.findByChatId("123"))!.tutorName).toBe("Salma Rizky");
  });

  it("persists across instances (new UserStore reads what previous wrote)", async () => {
    const { file } = freshStore();
    const first = new UserStore(file);
    await first.upsert(user("1", "Marcos Lopez"));
    await first.upsert(user("2", "Salma Rizky"));

    const second = new UserStore(file);
    expect(await second.all()).toHaveLength(2);
    expect((await second.findByChatId("2"))!.tutorName).toBe("Salma Rizky");
  });

  it("writes atomically and leaves no .tmp file behind", async () => {
    const { store, file } = freshStore();
    await store.upsert(user("1", "Marcos Lopez"));

    expect(existsSync(file)).toBe(true);
    expect(existsSync(`${file}.tmp`)).toBe(false);
    // The persisted file parses back to the same record shape { users: [] }.
    const saved = JSON.parse(readFileSync(file, "utf8")) as {
      users: UserRecord[];
    };
    expect(saved.users).toHaveLength(1);
    expect(saved.users[0]).toEqual(user("1", "Marcos Lopez"));
  });

  it("starts empty on a corrupt file instead of crashing", async () => {
    const { store, file } = freshStore();
    writeFileSync(file, "{ not valid json !!!");

    expect(await store.all()).toEqual([]);
    expect(await store.findByChatId("1")).toBeUndefined();
    // Registration still works after a corrupt read (recovery write).
    await store.upsert(user("1", "Marcos Lopez"));
    expect(await store.all()).toHaveLength(1);
  });
});