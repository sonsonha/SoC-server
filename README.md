# Personal Secretary Backend (Phase 00)

Fastify + Drizzle + PostgreSQL modular monolith. Phase 00 delivers **device auth** and a **sync stub** only.

## Stack

- Node.js 20+
- Fastify 5
- Zod
- PostgreSQL + Drizzle ORM
- Vitest

## LLM providers

| Mode | Env |
|------|-----|
| Fake (default) | `USE_FAKE_PROVIDERS=true` and `LLM_PROVIDER=auto` |
| DeepSeek (testing) | `LLM_PROVIDER=deepseek` + `DEEPSEEK_API_KEY` — works even with `USE_FAKE_PROVIDERS=true` so maps/search stay fake |
| Gemini | `LLM_PROVIDER=gemini` + `GEMINI_API_KEY`, or `USE_FAKE_PROVIDERS=false` + key with `LLM_PROVIDER=auto` |

Optional: `DEEPSEEK_MODEL` (default `deepseek-chat`). On startup logs `Provider selection { llm, fakeProviders }`.

## Local development

### Postgres options

**A. Postgres.app / local Postgres** (recommended on macOS):

```bash
createdb secretary   # or: psql -h localhost -d postgres -c 'CREATE DATABASE secretary'
```

Set `DATABASE_URL=postgres://YOUR_USER@localhost:5432/secretary` in `.env`.

**B. Docker Compose** (requires Docker Desktop running):

```bash
cd backend
docker compose up -d
# DATABASE_URL=postgres://postgres:postgres@localhost:5432/secretary
```

### 2. Configure env

```bash
cp .env.example .env
# edit DEVICE_AUTH_PEPPER to a long random string
```

### 3. Install & migrate & run

```bash
npm install
npm run db:migrate
npm run dev
```

Health check: `curl http://localhost:3000/health`

### 4. Register a device

```bash
curl -s -X POST http://localhost:3000/v1/device/register \
  -H 'content-type: application/json' \
  -d '{"label":"dev"}'
```

Save `deviceId` and `deviceSecret`. Re-register in dev with `"force": true`.

### 5. Authenticated ping

```bash
curl -s http://localhost:3000/v1/ping \
  -H "Authorization: Device <deviceId>:<deviceSecret>"
```

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | yes | Postgres connection string |
| `DEVICE_AUTH_PEPPER` | yes | Pepper for secret hashing (min 8 chars) |
| `PLANNER_WEB_TOKEN` | no | Server-only bearer token for the private Personal OS web proxy (min 32 chars) |
| `PORT` | no | Default `3000` |
| `HOST` | no | Default `0.0.0.0` |
| `NODE_ENV` | no | `development` / `test` / `production` |
| `LOG_LEVEL` | no | Default `info` |
| `REGISTER_TOKEN` | no | If set in production, required as `X-Register-Token` |
| `WORKER_ENABLED` | no | Phase 00: leave `false` (no jobs) |

## Android connectivity

| Client | Base URL |
|--------|----------|
| Emulator | `http://10.0.2.2:3000` |
| Physical device | `http://<your-lan-ip>:3000` (same Wi‑Fi; allow cleartext in debug) |

## Railway deploy

1. Create a Railway project with a **PostgreSQL** plugin.
2. Deploy this `backend/` service (Dockerfile).
3. Set `DATABASE_URL` (from plugin), `DEVICE_AUTH_PEPPER`, `NODE_ENV=production`.
4. Release command runs migrations (`railway.toml`).
5. Health check: `GET /health`.

## Tests

```bash
# crypto unit tests always run
# integration tests require DATABASE_URL
export DATABASE_URL=postgres://postgres:postgres@localhost:5432/secretary
export DEVICE_AUTH_PEPPER=test-pepper-abcdefgh
npm test
```

Integration tests write into that same database. After `npm test`, restore dogfood data:

```bash
npm run dev:data:reset
npm run seed:v2-goal-demo
```

See `docs/testing/v2-dev-data.md`. Reset refuses Railway/production URLs.

## API (Phase 00)

| Method | Path | Auth |
|--------|------|------|
| GET | `/health` | No |
| POST | `/v1/device/register` | No (token optional in prod) |
| GET | `/v1/ping` | Device |
| POST | `/v1/sync/pull` | Device |
| POST | `/v1/sync/push` | Device |

Auth header: `Authorization: Device <deviceId>:<deviceSecret>`

## Planner V2 web access

Planner V2 accepts the existing device header and signed requests from the private web proxy. Production uses a short-lived Ed25519 request signature: the public verification key ships with the backend while the private key remains in the web host. `PLANNER_WEB_TOKEN` remains available as a local-development fallback. Never put either credential in browser code or a `NEXT_PUBLIC_*` variable.

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/v2/planner?from&to` | Tasks, projects, goals, time blocks, and external events |
| POST / PATCH | `/v2/tasks`, `/v2/tasks/:id` | Capture and complete tasks |
| POST / PATCH / DELETE | `/v2/time-blocks`, `/v2/time-blocks/:id` | Schedule, move, and remove planner-owned blocks |

## Push notifications (Phase 07)

| Method | Path | Auth |
|--------|------|------|
| POST | `/v1/devices/fcm-token` | Device — `{ token, autonomy? }` |
| DELETE | `/v1/devices/fcm-token` | Device |
| PATCH | `/v1/devices/autonomy` | Device — `{ autonomy }` |
| POST | `/v1/proactive/scan` | Device — run scan once (debug) |

Set `FCM_SERVER_KEY` for legacy FCM HTTP delivery, or leave unset for no-op logging.
With `WORKER_ENABLED=true`, `proactive.scan` runs every `PROACTIVE_SCAN_INTERVAL_MS` (default 45 min).

Notification budget: `NOTIFY_MAX_PER_DAY` (default 8) plus per-type caps.
Autonomy gating: SUGGEST = PREP_READY only; INTERNAL_PLAN adds PLAN_UPDATED/DEADLINE; PROACTIVE_REPLAN adds WAITING_FOLLOW_UP.

## Google Calendar + Maps (Phase 09)

| Method | Path | Auth |
|--------|------|------|
| GET | `/v1/integrations/google/auth-url` | Device |
| POST | `/v1/integrations/google/connect` | Device — `{ mode: "fake" \| "token", … }` |
| GET | `/v1/integrations/status` | Device |
| GET | `/v1/calendar/events?from&to` | Device |
| POST | `/v1/calendar/sync` | Device — pull EXTERNAL events |

OAuth tokens are encrypted (`INTEGRATION_ENCRYPTION_KEY`) and never sent to Android.
With `USE_FAKE_PROVIDERS=true`, connect with `mode=fake` then sync.
`calendar.pull` runs every `CALENDAR_PULL_INTERVAL_MS` (15 min) when workers are enabled.
Maps Distance Matrix overrides travel minutes when `MAPS_API_KEY` is set (15 min cache).

For the browser OAuth flow, create a Google OAuth client with application type **Web
application** and register this redirect URI exactly (including scheme and path):

`https://YOUR-service.up.railway.app/v1/integrations/google/oauth-callback`

For a personal app left in Google OAuth **Testing**, add the Google account under
Audience → Test users. Set `GOOGLE_COS_CALENDAR_ID` to keep the requested access to the
single `calendar.events` scope; without it, calendar discovery/creation scopes are also
requested.

## Out of scope (later)

Apple Calendar, mutating EXTERNAL events, meeting-prep from attendees.
