# AutoTranslator

A multilingual messaging platform: a shared team inbox that automatically translates
inbound and outbound messages across multiple channels (Telegram, Android SMS gateway,
WhatsApp — plus placeholders for Messenger/Instagram/Email), so a team can converse with
contacts in their own language without anyone doing the translation by hand.

This repository is being built in phases against
[`docs/implementation-plan.md`](./docs/implementation-plan.md), the governing architecture
document. **This README currently reflects Phase 3 ("Foundation")** — the Next.js app
scaffold, database schema, auth, logging, error handling, and base navigation shell. Later
phases add the translation engine, the messaging core, and each channel adapter.

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

## Project structure (Phase 3)

```
prisma/
  schema.prisma        # Data model — see docs/implementation-plan.md §4 for design notes
  seed.ts               # Dev seed data
  migrations/           # Committed migration history
src/
  app/
    (auth)/             # Sign-in route group (public)
    (app)/               # Authenticated shell: role-aware nav + placeholder pages
    api/
      auth/[...nextauth]/  # Auth.js route handler
      health/               # GET /api/health — liveness/readiness
  server/
    env.ts               # Zod-validated process env (fails fast, see §6.7)
    logger.ts            # pino structured logging
    errors.ts             # AppError hierarchy + handleRouteError/toSafeActionError
    auth.ts               # Auth.js (NextAuth v5) config: Prisma adapter, Credentials + Email
    db.ts                  # Prisma client singleton
    roles.ts               # Role ordering + requireRole guard
    repositories/           # Org-scoped repository pattern (userRepository, organizationRepository)
  lib/
    schemas/               # Client-safe Zod schemas shared by forms
docker-compose.yml        # Local Postgres 16
.env.example                # All supported env vars, with comments
```

## Channel adapters

**Telegram is fully implemented (Phase 6)** — see
[`docs/channel-adapters.md`](./docs/channel-adapters.md) for bot creation via @BotFather,
local-dev tunneling (ngrok/cloudflared), webhook registration, and production setup.

**Android SMS gateway is fully implemented, server side (Phase 8)** — a physical Android
device (its own SIM, no cloud SMS vendor) polls the server for outbound sends and pushes
inbound SMS to it; see the "Android SMS gateway" section of
[`docs/channel-adapters.md`](./docs/channel-adapters.md) for the complete `/api/gateways/*`
API contract, and [`android-gateway/README.md`](./android-gateway/README.md) for the
companion Android app's build specification (permissions, foreground service, battery
optimization, retry behavior, carrier limitations, privacy disclosure). No Kotlin app ships
in this repo yet — those two documents are the complete spec for building one.

**WhatsApp Business Cloud API is fully implemented, gated behind `WHATSAPP_ENABLED`
(Phase 9)** — the official Meta Graph API (never unofficial browser
automation/session-hijacking), with real `X-Hub-Signature-256` webhook signature
validation and the GET-verify subscription handshake. With `WHATSAPP_ENABLED` unset/false
(the default), zero `WHATSAPP_*` env vars are required and both webhook routes are inert
(`404`); see the "WhatsApp Business Cloud API" section of
[`docs/channel-adapters.md`](./docs/channel-adapters.md) for the full, entirely-external,
Meta-side setup checklist (Business Manager account, App Review/Business Verification,
obtaining credentials, registering the webhook, and message-template approval) — none of
which this codebase can perform on your behalf.

## Multi-tenancy, security, and architecture notes

For the full rationale behind every architectural decision in this codebase (why Auth.js
over Clerk/Supabase, why OpenAI over DeepL/Google Translate, the org-isolation model, the
channel adapter interface, the inbound/outbound message lifecycles, and the phase-by-phase
build plan), see [`docs/implementation-plan.md`](./docs/implementation-plan.md). Do not
duplicate that document's content here — this README covers "how do I run this," the plan
covers "why does it work this way."
