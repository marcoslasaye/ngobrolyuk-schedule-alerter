#!/usr/bin/env node

/**
 * Schedule Alerter CLI entry point.
 *
 * Commands (full implementation lands in T024):
 *   - start       Run as a local daemon on the configured poll interval
 *   - run-once    Fetch once, diff, and alert (used by GitHub Actions)
 *   - test-config Validate config.yaml and exit
 *
 * This is a scaffolding stub. It prints a placeholder and exits so the
 * CLI surface exists and is invokable during Phase 1.
 */

import { fileURLToPath } from "node:url";

export function main(): void {
  const args = process.argv.slice(2);
  const command = args[0] ?? "start";

  // Stub output — replaced by the real dispatcher in T024.
  console.log(
    `schedule-alerter: command "${command}" not yet implemented (Phase 1 scaffolding).`,
  );
}

// Only run main() when this file is executed directly, not when imported.
const isMainModule =
  process.argv[1] != null &&
  process.argv[1].endsWith(fileURLToPath(import.meta.url).split(/[/\\]/).pop()!);

if (isMainModule) {
  main();
}
