# Schedule Alerter

Automated teacher schedule scraper with WhatsApp alerts.

Schedule Alerter polls a school's WordPress schedule page (admin-ajax), diffs
each week's classes against the previously cached state, and sends you a
single WhatsApp message whenever a class is added, removed, or changed. It
runs in Bali time (UTC+8) and respects configurable quiet hours so it never
buzzes you at midnight.

It is built to run on zero infrastructure: either as a local daemon on your
laptop or as a free GitHub Actions cron job.

## Features

- **7-day lookahead** — polls today through today+6 for the configured teacher.
- **Identity-based diffs** — detects added / removed / modified classes by a
  SHA-256 identity hash, so reordering rows never triggers false alerts.
- **First-run suppression** — the very first run establishes the baseline and
  does not spam you with "everything new".
- **Quiet hours** — configurable window (default 22:00–06:00 Bali time) during
  which alerts are queued and delivered as a single message when the window
  opens.
- **WhatsApp alerts** — via CallMeBot; after 3 consecutive failures it falls
  back to email / Telegram / a file log.
- **Crash-safe** — one failing date never stops the rest, and the cache is
  written atomically (temp file + rename).

## Requirements

- Node.js **>= 20** and npm
- A CallMeBot API key + your WhatsApp phone number (or an email/Telegram
  credential for the fallback channel)

## Quick start

### 1. Install

```bash
npm install
```

### 2. Configure

Copy the example config and fill in your values:

```bash
cp config.yaml.example config.yaml
```

Secrets are **not** committed — the config reads them from environment
variables using `${VAR}` placeholders, which are interpolated at startup:

```yaml
whatsapp:
  provider: "callmebot"
  apiKey: "${WHATSAPP_API_KEY}"
  phone: "${WHATSAPP_PHONE}"
```

Export the secrets before running:

```bash
export WHATSAPP_API_KEY="your-callmebot-key"
export WHATSAPP_PHONE="621234567890"   # no + sign, international format
```

> `config.yaml` is git-ignored because it contains credentials. Keep your
> real values there; commit only the sanitized `config.yaml.example`.

### 3. Validate config and notifier

Check your config parses and your delivery channel works before going live:

```bash
npm run test-config     # validates config.yaml, exits 1 on error
npm run test-notifier   # sends a test WhatsApp message
```

### 4. Run once (manual / smoke test)

```bash
npm run run-once
```

This fetches, diffs, alerts (if anything changed), and writes the cache. On
the first run it only establishes the baseline and does not alert.

## Commands reference

| Command | Script | What it does |
|---------|--------|--------------|
| Local daemon | `npm start` | Runs continuously as a cron loop at the configured interval |
| Run once | `npm run run-once` | Single fetch → diff → alert cycle |
| Validate config | `npm run test-config` | Checks `config.yaml` and exits |
| Probe notifier | `npm run test-notifier` | Sends a test message to verify delivery |
| Build | `npm run build` | Compiles TypeScript to `dist/` |
| Test | `npm test` | Runs the full vitest suite |

The compiled CLI can also be invoked directly:

```bash
node dist/cli.js run-once
node dist/cli.js start
node dist/cli.js test-config
node dist/cli.js test-notifier
```

## Configuration reference

All settings live in `config.yaml`:

| Key | Default | Description |
|-----|---------|-------------|
| `teacherId` | — (required) | Identifier for the schedule to scrape |
| `dateRange` | `7` | Number of days to look ahead |
| `pollIntervalMs` | `1800000` | Daemon poll interval (30 min) |
| `quietHours.start` / `.end` | `22:00` / `06:00` | Quiet window (Bali time) |
| `quietHours.tz` | `Asia/Makassar` | IANA timezone for quiet hours |
| `whatsapp.provider` | `callmebot` | Delivery provider |
| `whatsapp.apiKey` | `${WHATSAPP_API_KEY}` | CallMeBot API key |
| `whatsapp.phone` | `${WHATSAPP_PHONE}` | Destination phone number |
| `fallback.type` | `email` | `email` \| `telegram` \| `none` |
| `cachePath` | `~/.schedule-cache/` | Where the JSON cache is stored |

## Deployment options

### Option A — Local daemon (most reliable)

```bash
npm run build
npm start
```

Keep it running (e.g. with `pm2`, a systemd service, or `nohup`). It will
poll every 30 minutes and re-engage after errors automatically.

### Option B — GitHub Actions cron (zero infrastructure)

A workflow is included at `.github/workflows/schedule-alerter.yml`. It runs the
scraper every 30 minutes on GitHub's hosted runners.

1. Push this repo to GitHub.
2. Add repository **Actions secrets**:
   - `WHATSAPP_API_KEY`
   - `WHATSAPP_PHONE`
   - `SMTP_USER` and `SMTP_PASS` (only if you use the email fallback)
3. The `schedule-alerter` workflow runs on the given cron and on manual
   dispatch (Actions → *Run workflow*).

Notes for the GitHub Actions path:

- Runners are **ephemeral**, so schedule state is not persisted between runs.
  Each scheduled run essentially starts fresh, which the app treats as a first
  run and therefore does **not** re-alert. For reliable change detection, use
  the local daemon where the cache persists.
- The workflow builds and runs the test suite before each scheduled run so a
  broken commit never goes out silently.

### Option C — Docker

A production-ready `Dockerfile` is included (multi-stage build, non-root user,
and a healthcheck). See [Docker](#docker) below.

## Docker

```bash
docker build -t schedule-alerter .

# Single run (pass secrets via --env-file or -e):
docker run --rm --env-file .env \
  -v "$(pwd)/config.yaml:/app/config.yaml" \
  schedule-alerter run-once

# Continuous daemon (persist the cache across runs):
docker run -d --env-file .env \
  -v "$(pwd)/config.yaml:/home/nodeapp/.schedule-alerter/config.yaml" \
  -v schedule-cache:/home/nodeapp/.schedule-cache \
  schedule-alerter start
```

The image builds in three stages (deps → build → runtime) so the final image
is small. It runs as a **non-root user** with a healthcheck, and reads its
configuration from `config.yaml` plus the `WHATSAPP_*` / `SMTP_*` env vars.
Mount `config.yaml` into `/app/config.yaml` (or the app user's
`~/.schedule-alerter/`) and a volume on `~/.schedule-cache` to persist state
across container restarts.

## Architecture overview

Single-process Node.js/TypeScript application. Four domain modules talk
through typed port interfaces, coordinated by a central orchestrator:

```
cli.ts ──→ orchestrator.ts
              │
              ├─→ fetcher/client.ts ──→ WP AJAX endpoint (×7 dates)
              │         │
              │         ▼
              │    fetcher/parser.ts ──→ ScheduleEntry[]
              │
              ├─→ differ/engine.ts ──→ ScheduleDiff { added, removed, modified }
              │
              ├─→ scheduler/cache.ts ──→ load previous state / save current
              │
              ├─→ notifier/queue.ts ──→ quiet hours check + dedup
              │         │
              │         ▼
              ├─→ notifier/whatsapp.ts ──→ CallMeBot API
              │         │ (on 3 consecutive failures)
              │         ▼
              └─→ notifier/fallback.ts ──→ email / Telegram / file log
```

- **fetcher** — HTTP POST to `admin-ajax.php`, 3× exponential-backoff retries,
  10s timeout, then Cheerio HTML parsing into structured records.
- **differ** — SHA-256 identity (student + language + date) and add/remove/
  modify detection; immune to row reordering.
- **notifier** — message formatting, quiet-hours queue with per-cycle dedup,
  CallMeBot delivery with 2× retry, and a fallback after persistent failure.
- **scheduler** — cache persistence (atomic writes) and the `pollOnce` /
  daemon orchestrator with per-date error isolation.

## Project layout

```
src/
├── config/       # Zod schema + YAML/env loader
├── fetcher/      # HTTP client + HTML parser + types
├── differ/       # Change detection engine + types
├── notifier/     # Formatter, WhatsApp, fallback, queue, types
├── scheduler/    # Cache, orchestrator, types
├── cli.ts        # start | run-once | test-config | test-notifier
└── index.ts      # Public re-exports for the test harness
__fixtures__/     # Recorded HTML fixtures for the tests
```

## Troubleshooting

| Symptom | Likely cause / fix |
|---------|--------------------|
| `config: invalid` on `test-config` | Missing required field or unset env var; the error prints the field name. |
| No WhatsApp message | CallMeBot key/phone wrong, or the change happened inside quiet hours (queued until 06:00). |
| Nothing on first run | Expected — first run only establishes the baseline. |
| Repeated full-schedule alerts on GitHub Actions | Runners are ephemeral; each run starts fresh. Use the local daemon for persistent diffing. |
| One date fails but others succeed | By design — errors are isolated per date; check logs for the failing date. |

## License

MIT
