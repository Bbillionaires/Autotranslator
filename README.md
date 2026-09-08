# AutoTranslator

A multilingual messaging platform: a shared team inbox that automatically translates
inbound and outbound messages across multiple channels (Telegram, Android SMS gateway,
WhatsApp — plus placeholders for Messenger/Instagram/Email), so a team can converse with
contacts in their own language without anyone doing the translation by hand.

This repository was built in phases against
[`docs/implementation-plan.md`](./docs/implementation-plan.md), the governing architecture
document. **This README reflects the current, post-review state of the MVP** — all of the
following are fully built and covered by the test suite: Telegram (fully implemented),
Android SMS gateway (fully implemented, server side), WhatsApp Business Cloud API
(fully implemented, gated behind `WHATSAPP_ENABLED`), the full shared-inbox UI (contacts,
conversations, message threads with original/translated toggle, review-before-send,
internal notes, glossary, team/user management, settings), security headers, rate limiting
on every public/webhook-adjacent endpoint, an internal retry-worker endpoint for automatic
send retries, and Android device-management UI (register/list/revoke). See
`docs/review-report.md` and `docs/test-report.md` for the full independent review/test
history (every finding's status is tracked there). The application has also been deployed
to Railway — see "Deployment (Railway)" below for how to reproduce that.

## Product overview

- **Shared inbox**: agents see one conversation per contact-per-channel, with the
  contact's message shown translated into the agent's language and their own reply
  translated back into the contact's language automatically.
- **Multi-tenant**: every organization's users, contacts, conversations, and messages are
  isolated from every other organization.
- **Role-based access**: `OWNER > ADMINISTRATOR > MANAGER > AGENT > VIEWER`, enforced
  server-side on every sensitive action.
- **Channels** (see `docs/implementation-plan.md` §3.2 for the full adapter architecture):
  Telegram and an Android-device SMS gateway are the two channels this MVP fully
  implements; WhatsApp is built production-shaped but gated behind a feature flag;
  Messenger/Instagram/Email are placeholder adapters reserved for later.

## Prerequisites

- **Node.js 22.x** (`>=22 <23`, pinned in `package.json#engines` and `.nvmrc`). If you use
  `nvm`, run `nvm use` in the repo root.
- **npm** (ships with Node; this repo commits `package-lock.json` and does not use
  pnpm/yarn).
- **Docker** and **Docker Compose** (for the local Postgres 16 instance).

## Installation

```bash
nvm use          # optional, if you use nvm — picks up Node 22 from .nvmrc
npm install       # installs dependencies; postinstall runs `prisma generate`
```

## Environment setup

```bash
cp .env.example .env
```

Then edit `.env`. At minimum, for local development you need:

- `DATABASE_URL` / `DIRECT_URL` — point at the docker-compose Postgres (the example values
  in `.env.example` already match `docker-compose.yml`'s default dev credentials).
- `AUTH_SECRET` — generate one with `openssl rand -base64 32`.
- `APP_URL` — `http://localhost:3000` for local dev.

Everything else in `.env.example` is optional/conditional and defaults to "off":

- `TRANSLATION_PROVIDER` defaults to `noop` (a local passthrough — no API key needed).
- `TELEGRAM_ENABLED`, `ANDROID_GATEWAY_ENABLED`, `WHATSAPP_ENABLED` all default to `false`,
  and only `*_ENABLED=true` makes that channel's other env vars required. See
  `src/server/env.ts` for the exact validation logic and `docs/implementation-plan.md`
  §6.7 for the rationale.
- The Auth.js **Email (magic link)** provider does not require any email-sending
  credentials to boot: in local development, the sign-in link is printed to the server
  console instead of being emailed (see `src/server/auth.ts`).

`npm run dev` will throw a descriptive startup error listing exactly which environment
variables are missing/invalid if validation fails (see `src/server/env.ts`).

## Database setup

Start local Postgres 16 via Docker Compose:

```bash
docker compose up -d
```

This runs a single `postgres` service on `localhost:5432` with a named volume
(`autotranslator_postgres_data`) so data survives container restarts, using local-only
dev credentials defined in `docker-compose.yml` (never use these in production).

### Migrations

```bash
npm run db:migrate      # `prisma migrate dev` — creates/applies migrations against your local DB
npx prisma validate      # validates prisma/schema.prisma without touching the DB
npx prisma studio         # optional: browse the DB in a local GUI
```

The committed migration history lives in `prisma/migrations/`. In CI/CD or production,
use `prisma migrate deploy` instead of `migrate dev` (deploy never prompts and never
generates new migrations — it only applies existing ones).

### Seed data

```bash
npm run db:seed
```

This runs `prisma/seed.ts`, which creates one demo organization ("Acme Demo Co") with:

- Five users, one per role (`OWNER`/`ADMINISTRATOR`/`MANAGER`/`AGENT`/`VIEWER`), all
  sharing one known dev password. **The seed script prints every seeded user's email and
  the shared password to the console when it finishes** — use those to sign in.
- One team with mixed membership (a lead plus two members).
- Three channel accounts: Telegram (active), Android SMS (active), WhatsApp
  (pending-setup, since `WHATSAPP_ENABLED` defaults to off).
- Eight contacts with varied preferred languages (one deliberately has no
  `preferredLanguage` set, to exercise the detected-language fallback).
- Several conversations with realistic message history, including one message in a
  `FAILED` state and one in a `DEAD_LETTER` state, so retry-related UI (built in a later
  phase) has real data to render against.

## Local development

```bash
docker compose up -d   # start Postgres (if not already running)
npm run db:migrate      # first time only, or after schema changes
npm run db:seed         # first time only, or whenever you want fresh demo data
npm run dev             # start the Next.js dev server
```

Then visit `http://localhost:3000` — you'll be redirected to `/sign-in`. Sign in with any
seeded user's email and the dev password printed by `npm run db:seed`, or request a magic
link (check the server console/terminal running `npm run dev` for the printed link — no
real email is sent locally).

### Available scripts

| Script                                    | Purpose                                            |
| ----------------------------------------- | -------------------------------------------------- |
| `npm run dev`                             | Start the Next.js dev server                       |
| `npm run build` / `npm run start`         | Production build / start                           |
| `npm run lint` / `npm run lint:fix`       | ESLint                                             |
| `npm run format` / `npm run format:check` | Prettier                                           |
| `npm run typecheck`                       | `tsc --noEmit`                                     |
| `npm run db:migrate`                      | `prisma migrate dev`                               |
| `npm run db:seed`                         | `prisma db seed` (runs `prisma/seed.ts` via `tsx`) |
| `npm run db:studio`                       | `prisma studio`                                    |

### Verifying everything works (what CI checks)

```bash
npm run lint
npm run typecheck
npx prisma validate
```

All three must pass with zero errors. A minimal GitHub Actions workflow running the same
checks (plus `npm ci`) lives at `.github/workflows/ci.yml`.

## Project structure

```
prisma/
  schema.prisma          # Data model — see docs/implementation-plan.md §4 for design notes
  seed.ts                 # Dev seed data
  migrations/             # Committed migration history
src/
  app/
    (auth)/               # Sign-in route group (public)
    (app)/                 # Authenticated shell: nav, translation-disclosure banner (M2),
                            #   contacts, teams, settings (channel integrations, users, glossary)
      inbox/[conversationId]/  # Message thread, composer, high-risk banner, retry actions
    api/
      auth/[...nextauth]/    # Auth.js route handler
      channels/telegram/     # Telegram webhook route (+ /language self-service handling)
      channels/whatsapp/      # WhatsApp webhook route (GET verify handshake + POST inbound)
      gateways/                # Android SMS gateway: register/heartbeat/inbound/messages/etc.
      internal/retry-worker/    # Shared-secret-gated cron entrypoint for automatic retries
      health/                    # GET /api/health — liveness/readiness
  server/
    env.ts                 # Zod-validated process env (fails fast, see §6.7)
    logger.ts               # pino structured logging
    errors.ts                # AppError hierarchy + handleRouteError/toSafeActionError
    auth.ts                  # Auth.js (NextAuth v5) config: Prisma adapter, Credentials + Email
    authTokenRefresh.ts        # Per-request JWT re-check (deactivation/role-change enforcement)
    db.ts                       # Prisma client singleton
    roles.ts                     # Role ordering + requireRole guard
    rateLimit.ts                  # Shared in-process rate limiter (webhooks, gateways, auth)
    actions/                       # Server Actions (contacts, conversations, messages, teams,
                                    #   users, telegram, whatsapp, android, glossary, settings)
    channels/                       # Channel adapter interface + Telegram/WhatsApp/Android impls
    messaging/                       # Inbound/outbound lifecycles, retry/backoff, idempotency
    translation/                      # Translation engine + provider implementations
    repositories/                      # Org-scoped repository pattern (one file per model)
  middleware.ts            # Security headers (HSTS, CSP, X-Frame-Options, etc.)
  lib/
    schemas/                # Client-safe Zod schemas shared by forms
android-gateway/           # Spec (no code shipped) for the companion Android SMS gateway app
docker-compose.yml         # Local Postgres 16
.env.example                # All supported env vars, with comments
```

## Channel adapters

**Telegram is fully implemented, per-organization (Phase 6, rewritten for multi-tenant
credentials)** — each organization connects its OWN bot (from Settings, in-app) rather than
this deployment sharing one global bot token; see
[`docs/channel-adapters.md`](./docs/channel-adapters.md) for bot creation via @BotFather,
local-dev tunneling (ngrok/cloudflared), and the in-app connect flow.

**Android SMS gateway is fully implemented, server side (Phase 8)** — a physical Android
device (its own SIM, no cloud SMS vendor) polls the server for outbound sends and pushes
inbound SMS to it; see the "Android SMS gateway" section of
[`docs/channel-adapters.md`](./docs/channel-adapters.md) for the complete `/api/gateways/*`
API contract, and [`android-gateway/README.md`](./android-gateway/README.md) for the
companion Android app's build specification (permissions, foreground service, battery
optimization, retry behavior, carrier limitations, privacy disclosure). No Kotlin app ships
in this repo yet — those two documents are the complete spec for building one.

**WhatsApp Business Cloud API is fully implemented, per-organization, gated behind
`WHATSAPP_ENABLED`** — the official Meta Graph API (never unofficial browser
automation/session-hijacking), with real `X-Hub-Signature-256` webhook signature
validation (checked against each organization's own app secret) and the GET-verify
subscription handshake. With `WHATSAPP_ENABLED` unset/false (the default), the adapter/
routes are inert (`404`); with it on, each organization pastes its own Cloud API
credentials from Settings (validated against the Graph API before saving) rather than this
deployment sharing one global set of `WHATSAPP_*` env vars. See the "WhatsApp Business
Cloud API" section of [`docs/channel-adapters.md`](./docs/channel-adapters.md) for the full,
entirely-external, Meta-side setup checklist (Business Manager account, App
Review/Business Verification, obtaining credentials, registering the per-organization
webhook URL, and message-template approval) — none of which this codebase can perform on
your behalf.

**Channel credentials are encrypted at rest, per organization** — see
[`docs/channel-adapters.md`](./docs/channel-adapters.md)'s "Per-organization credential
encryption" section and `src/server/crypto/credentialEncryption.ts` for the AES-256-GCM
design (`CREDENTIAL_ENCRYPTION_KEY`, required whenever any of Telegram/WhatsApp/Android
gateway is enabled).

## Scheduling the retry worker in production

Automatic retry/backoff for transient send failures (`src/server/messaging/retryQueue.ts`'s
`runRetryWorkerOnce`) is driven by `GET`/`POST /api/internal/retry-worker`, which is **not**
invoked automatically by anything inside the app — you must schedule an external caller to
hit it periodically (every 1–5 minutes is reasonable), or `FAILED` messages will only ever
be retried when a human clicks "Retry" in the inbox UI.

1. Set `INTERNAL_WORKER_SECRET` (generate one with `openssl rand -hex 32`) — the route
   refuses to run at all (`503`) if this is unset, and rejects (`401`) any request whose
   `X-Internal-Worker-Secret` header doesn't match.
2. Point a scheduler at it:

   **Vercel Cron** (`vercel.json`):

   ```json
   {
     "crons": [{ "path": "/api/internal/retry-worker", "schedule": "*/5 * * * *" }]
   }
   ```

   Vercel Cron sends a `GET` with no custom headers by default — if you need the shared
   secret enforced on Vercel, use a Vercel Cron Job that's configured to include a custom
   header, or front it with a lightweight wrapper. Simplest self-hosted alternative below
   avoids this entirely since you control the request.

   **Self-hosted (systemd timer / plain cron)**:

   ```cron
   */5 * * * * curl -fsS -X POST https://app.example.com/api/internal/retry-worker \
     -H "X-Internal-Worker-Secret: $INTERNAL_WORKER_SECRET"
   ```

   **Self-hosted (`node-cron`, if you'd rather run it in-process alongside the app)**:

   ```ts
   import cron from "node-cron";
   cron.schedule("*/5 * * * *", () => {
     fetch(`${process.env.APP_URL}/api/internal/retry-worker`, {
       method: "POST",
       headers: { "X-Internal-Worker-Secret": process.env.INTERNAL_WORKER_SECRET! },
     }).catch((err) => console.error("retry-worker cron call failed", err));
   });
   ```

   (`node-cron` isn't a dependency of this repo — add it if you choose this option.)

The route processes every organization's due `FAILED` messages in one pass and returns
`{ ok: true, attempted, succeeded, failed }`.

## Deployment (Railway)

This app has been deployed to [Railway](https://railway.app) — a Postgres service plus a
web service built from this GitHub repo, in one project.

### 1. Postgres service

Add a Postgres database to the Railway project (Railway's own "Database → PostgreSQL"
template). Railway exposes its connection string as `DATABASE_URL` on that service; the web
service below needs to reference it (Railway's variable-reference syntax, e.g.
`${{Postgres.DATABASE_URL}}`, lets one service read another's variables without copy-pasting
a secret between them).

### 2. Web service (from GitHub)

Create a second service in the same project, connected to this repository (Railway
auto-detects the Next.js build via Nixpacks — no `Dockerfile` needed). Set:

- **Build command**: default (Nixpacks runs `npm install && npm run build`).
- **Start command**: `npm run start` (or leave default — `package.json#scripts.start` runs
  `next start`).
- **Pre-deploy command** (`preDeployCommand` in Railway's service settings): see below.

### 3. Required environment variables

Mirror `.env.example` (see that file for the full, commented list). At minimum:

- `DATABASE_URL` / `DIRECT_URL` — both set to the Postgres service's connection string
  (Railway variable reference, e.g. `${{Postgres.DATABASE_URL}}` for both, since there's no
  separate pooler in this deployment shape).
- `AUTH_SECRET` — `openssl rand -base64 32`.
- `APP_URL` — the web service's public Railway domain (see step 5), e.g.
  `https://autotranslator-production.up.railway.app`.
- `LOG_LEVEL` — `info` (or your preference).
- `TRANSLATION_PROVIDER` + `OPENAI_API_KEY` if you want real translation (otherwise leave
  `TRANSLATION_PROVIDER=noop`, which needs no key).
- Whichever of `TELEGRAM_ENABLED`/`ANDROID_GATEWAY_ENABLED`/`WHATSAPP_ENABLED` (plus their
  conditional `*_TOKEN`/`*_SECRET` vars) you're actually turning on for this deployment.
- `INTERNAL_WORKER_SECRET` — required for the retry-worker cron pattern below to be
  reachable at all (the route fails closed with `503` if unset).

### 4. The `preDeployCommand` pattern

Railway's **pre-deploy command** runs once per deploy, before the new instance receives
traffic — the right place for `prisma migrate deploy`. This project's `preDeployCommand`
is:

```
npx prisma migrate deploy && npx prisma db seed
```

**Known simplification — flagging this deliberately, not silently:** `prisma db seed` runs
`prisma/seed.ts`, which is dev/demo seed data (a fixed "Acme Demo Co" organization with
seeded users at a shared known password — see "Seed data" above). Including it in
`preDeployCommand` means **every deploy re-seeds**, not just the first one. That's fine (and
convenient) for a demo/staging environment, but it is not what a real production setup
should do long-term:

- After the first successful deploy, remove `&& npx prisma db seed` from
  `preDeployCommand`, leaving just `npx prisma migrate deploy` — migrations should keep
  running on every deploy, seeding should not.
- If you need one-off production data (an initial Owner account, say), run
  `npx prisma db seed` manually once via `railway run npx prisma db seed`, or write a
  separate, idempotent production-bootstrap script instead of reusing the demo seed.

This is called out here explicitly so it isn't mistaken for the intended long-term
production configuration.

### 5. Generating a public domain

Railway's web service settings → **Networking** → **Generate Domain** issues a free
`*.up.railway.app` HTTPS domain for the service (or attach a custom domain there instead).
Whichever you use, set `APP_URL` (step 3) to that exact URL — it's used for absolute links
(magic-link sign-in emails, webhook-registration instructions) and, if you're running
Telegram/WhatsApp, is the base URL those channels' webhooks need to reach.

### 6. After first deploy

- Set `CREDENTIAL_ENCRYPTION_KEY` (required whenever `TELEGRAM_ENABLED`, `WHATSAPP_ENABLED`,
  or `ANDROID_GATEWAY_ENABLED` is true — generate one with `openssl rand -hex 32`) BEFORE
  the first organization connects any channel; it encrypts every organization's channel
  credentials at rest (see `docs/channel-adapters.md`'s "Per-organization credential
  encryption" section).
- If `TELEGRAM_ENABLED=true`: each organization's own Administrator connects their own bot
  from **Settings → Telegram** (paste the bot token from @BotFather — the app validates it,
  generates a per-organization webhook secret, and registers the webhook with Telegram
  automatically at `${APP_URL}/api/channels/telegram/webhook/{channelAccountId}`). See
  `docs/channel-adapters.md`'s Telegram section.
- If `WHATSAPP_ENABLED=true`: each organization's own Administrator connects their own
  WhatsApp Cloud API credentials from **Settings → WhatsApp Business** (validated against
  the Graph API before saving), then registers the shown webhook URL
  (`${APP_URL}/api/channels/whatsapp/webhook/{channelAccountId}`) and their own
  `verifyToken` in Meta's App Dashboard.
- Point an external scheduler at `${APP_URL}/api/internal/retry-worker` per "Scheduling the
  retry worker in production" above — Railway has no built-in cron primitive for a web
  service, so use an external scheduler (a separate Railway **Cron Job** template hitting
  the URL with `curl`, or any third-party uptime/cron service) rather than `node-cron`
  in-process (Railway can scale a web service to multiple instances, which would fire the
  in-process cron once per instance).

## Multi-tenancy, security, and architecture notes

For the full rationale behind every architectural decision in this codebase (why Auth.js
over Clerk/Supabase, why OpenAI over DeepL/Google Translate, the org-isolation model, the
channel adapter interface, the inbound/outbound message lifecycles, and the phase-by-phase
build plan), see [`docs/implementation-plan.md`](./docs/implementation-plan.md). Do not
duplicate that document's content here — this README covers "how do I run this," the plan
covers "why does it work this way."
