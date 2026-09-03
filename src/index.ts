/**
 * Public exports for the test harness and external consumers.
 *
 * Every domain's public surface is re-exported here:
 *   - fetcher: types + parser + client
 *   - differ: types + engine
 *   - notifier: types + formatter + whatsapp + fallback + queue
 *   - scheduler: types + cache + orchestrator
 *   - config: schema + loader
 *
 * Importers that need the whole surface can `import * as scheduleAlerter
 * from "schedule-alerter"`.
 */

// ---------------------------------------------------------------------------
// Fetcher domain
// ---------------------------------------------------------------------------
export type { ScheduleEntry, RawScheduleResponse } from "./fetcher/types.js";
export { computeHash, parseSchedule } from "./fetcher/parser.js";
export {
  fetchSchedule,
  type FetcherClientOptions,
  type FetcherPort,
} from "./fetcher/client.js";

// ---------------------------------------------------------------------------
// Differ domain
// ---------------------------------------------------------------------------
export type {
  ChangeType,
  ChangeEvent,
  ScheduleDiff,
} from "./differ/types.js";
export { diffEntries, type DiffResult, type DifferPort } from "./differ/engine.js";

// ---------------------------------------------------------------------------
// Notifier domain
// ---------------------------------------------------------------------------
export type {
  AlertPayload,
  ChangeSummary,
  DeliveryResult,
} from "./notifier/types.js";
export { formatAlert, formatDate, type FormatterPort } from "./notifier/formatter.js";
export {
  sendWhatsApp,
  type WhatsAppConfig,
  type WhatsAppPort,
} from "./notifier/whatsapp.js";
export { sendFallback, type FallbackConfig } from "./notifier/fallback.js";
export { AlertQueue, type QuietHoursConfig, type QueueOptions } from "./notifier/queue.js";

// ---------------------------------------------------------------------------
// Scheduler domain
// ---------------------------------------------------------------------------
export type { CacheSchema, PollResult } from "./scheduler/types.js";
export { loadCache, saveCache, cachePathFor, type CachePort } from "./scheduler/cache.js";
export {
  ScheduleOrchestrator,
  createOrchestrator,
  type CycleResult,
  type OrchestratorDeps,
} from "./scheduler/orchestrator.js";

// ---------------------------------------------------------------------------
// Config domain
// ---------------------------------------------------------------------------
export type { ConfigSchema } from "./config/schema.js";
export {
  loadConfig,
  loadConfigFile,
  resolveConfigPath,
  interpolateEnv,
  type ConfigPort,
} from "./config/loader.js";