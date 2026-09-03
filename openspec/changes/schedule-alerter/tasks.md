# Tasks: Schedule Alerter

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | 1000–1300 |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | 5 PRs (foundation → fetcher → differ → notifier → orchestrator+CLI+polish) |
| Delivery strategy | ask-on-risk |

Decision needed before apply: Yes
Chained PRs recommended: Yes
Chain strategy: pending
400-line budget risk: High

### Suggested Work Units

| Unit | Goal | Likely PR | Notes |
|------|------|-----------|-------|
| 1 | Project scaffolding, config, types | PR 1 | Base: main. All port interfaces defined. |
| 2 | Fetcher domain (HTTP + parser) | PR 2 | Base: PR 1 branch. HTTP fixtures + tests. |
| 3 | Differ domain (hash + diff) | PR 3 | Base: PR 2 branch. Unit tests with fixture pairs. |
| 4 | Notifier domain (WhatsApp + fallback + queue) | PR 4 | Base: PR 3 branch. Mocked API tests. |
| 5 | Orchestrator, CLI, cache, e2e, docs | PR 5 | Base: PR 4 branch. Integration test + README. |

## Phase 1: Project Setup

- [x] **T001** Init `package.json` + `tsconfig.json` (ES2022, strict, ESM) | setup | [] | FR: config | ~15min
- [x] **T002** Install deps: cheerio, node-cron, date-fns-tz, zod, yaml, axios, nodemailer, telegraf, vitest, nock | setup | [T001] | NFR: deps | ~10min
- [x] **T003** Create directory scaffold: `src/{config,fetcher,differ,notifier,scheduler}`, `__fixtures__/` | setup | [T001] | — | ~5min

## Phase 2: Config & Types

- [x] **T004** Define `src/fetcher/types.ts`: ScheduleEntry, RawScheduleResponse | config | [T003] | Spec: fetcher FR | ~15min
- [x] **T005** Define `src/differ/types.ts`: ScheduleDiff, ChangeEvent, ChangeType | config | [T003] | Spec: differ FR | ~10min
- [x] **T006** Define `src/notifier/types.ts`: AlertPayload, ChangeSummary, DeliveryResult | config | [T003] | Spec: notifier FR | ~10min
- [x] **T007** Define `src/scheduler/types.ts`: CacheSchema, PollResult | config | [T003] | Spec: scheduler FR | ~10min
- [x] **T008** Implement `src/config/schema.ts`: Zod schema for ConfigSchema with defaults + env interpolation | config | [T004, T005, T006, T007] | Spec: scheduler FR-config | ~20min
- [x] **T009** Implement `src/config/loader.ts`: YAML read + Zod validate + env var `${VAR}` expansion | config | [T008] | Spec: scheduler FR-config | ~20min
- [x] **T010** Create `config.yaml` with Bali TZ, 30min interval, CallMeBot, email fallback template | config | [T008] | Spec: scheduler FR-config | ~10min

## Phase 3: Cache Layer

- [x] **T011** Implement `src/scheduler/cache.ts`: JSON R/W at `~/.schedule-cache/last-schedule.json` with atomic write (temp+rename) | scheduler | [T007] | Spec: scheduler FR-persistence | ~25min

## Phase 4: Fetcher Domain

- [ ] **T012** Implement `src/fetcher/client.ts`: axios POST to `admin-ajax.php`, 3x exponential backoff, 10s timeout | fetcher | [T004] | Spec: fetcher FR-fetch | ~25min
- [ ] **T013** Implement `src/fetcher/parser.ts`: Cheerio HTML → ScheduleEntry[], empty/selector-mismatch → `[]` + warn | fetcher | [T004] | Spec: fetcher FR-parse | ~30min
- [ ] **T014** Record HTML fixtures: `__fixtures__/schedule-single-day.html`, `schedule-empty.html`, `schedule-malformed.html` | fetcher | [T013] | Spec: fetcher scenarios | ~15min
- [ ] **T015** Unit tests: `fetcher/client.test.ts` (nock-recorded retries, timeout), `fetcher/parser.test.ts` (3 fixtures) | fetcher | [T012, T013, T014] | Spec: fetcher FR, NFR | ~30min

## Phase 5: Differ Domain

- [ ] **T016** Implement `src/differ/engine.ts`: SHA-256(student+language+date) identity, add/remove/modify diff, ignore reorder | differ | [T005] | Spec: differ FR-hash, FR-diff | ~30min
- [ ] **T017** Unit tests: `differ/engine.test.ts` — hash stability, add/remove/modify, reorder-safe, first-run, dedup | differ | [T016] | Spec: differ all scenarios | ~25min

## Phase 6: Notifier Domain

- [ ] **T018** Implement `src/notifier/formatter.ts`: AlertPayload → WhatsApp text string per template spec | notifier | [T006] | Spec: notifier FR-format | ~15min
- [ ] **T019** Implement `src/notifier/whatsapp.ts`: CallMeBot GET, 2x retry w/ 5s delay, 429/5xx = transient | notifier | [T006, T018] | Spec: notifier FR-send, FR-retry | ~25min
- [ ] **T020** Implement `src/notifier/fallback.ts`: nodemailer (email) + telegraf (Telegram) clients | notifier | [T006] | Spec: notifier FR-fallback | ~25min
- [ ] **T021** Implement `src/notifier/queue.ts`: quiet hours gate (Asia/Makassar), dedup per hash, batch-at-wake | notifier | [T006, T019, T020] | Spec: scheduler FR-quiet, notifier FR-dedup | ~30min
- [ ] **T022** Unit tests: `notifier/whatsapp.test.ts`, `notifier/fallback.test.ts`, `notifier/queue.test.ts` with mocked APIs | notifier | [T018, T019, T020, T021] | Spec: notifier all scenarios | ~30min

## Phase 7: Orchestrator & Scheduler

- [ ] **T023** Implement `src/scheduler/orchestrator.ts`: main loop (fetch→diff→notify per date), error isolation per date, structured logging | scheduler | [T011, T012, T013, T016, T021] | Spec: scheduler FR-poll, NFR-error | ~35min

## Phase 8: CLI & Entry Point

- [ ] **T024** Implement `src/cli.ts`: commands `start` (daemon), `run-once`, `test-config`, `test-notifier`, help/version | cli | [T009, T023] | Spec: scheduler FR-deploy | ~20min
- [ ] **T025** Implement `src/index.ts`: public re-exports for test harness | cli | [T004, T005, T006, T007] | — | ~5min

## Phase 9: Integration & Polish

- [ ] **T026** E2E test: recorded HTML fixtures → run-once → assert DeliveryResult shape | polish | [T024] | Spec: all FR | ~25min
- [ ] **T027** `.github/workflows/schedule.yml`: cron `*/30 * * * *`, build + run-once, secrets for env vars | polish | [T024] | NFR: deploy | ~15min
- [ ] **T028** README.md: setup, config, run modes, troubleshooting | polish | [T027] | NFR: docs | ~20min
- [ ] **T029** Dockerfile (optional): multi-stage `node:24-alpine` | polish | [T024] | NFR: deploy | ~10min
