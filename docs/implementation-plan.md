# AutoTranslator — Implementation Plan

**Repo:** `bbillionaires/autotranslator` · **Branch:** `claude/multilingual-messaging-mvp-j3dxp4`
**Status:** Planning document only. No application code exists yet; this plan governs the build.
**Author:** Planning agent · **Date:** 2026-07-26

---

## 1. Repository Inspection Findings

- `git -C /workspace/autotranslator branch --show-current` → `claude/multilingual-messaging-mvp-j3dxp4` (confirmed checked out).
- `git status` → `No commits yet`, working tree clean.
- `ls -Aa /workspace/autotranslator` → only `.git` (and now `docs/`, created by this task). The repository is **completely greenfield**: no source, no config, no lockfile, no CI. There is no legacy code to reconcile with and no backward-compatibility constraint on any decision below.
- Toolchain observed in the environment: Node `v22.22.2`, npm `10.9.7`. Node 22 is the current LTS line — **pin Node 22.x** via `"engines": { "node": ">=22 <23" }` in `package.json` and a `.nvmrc` containing `22`.
- **Package manager: npm.** It's already present, requires no extra install step for contributors, and this is a single-app repo (no monorepo/workspaces needed), so npm's lower ceremony beats pnpm/yarn here. `package-lock.json` will be committed.
- Because the repo is empty, this plan assumes greenfield defaults everywhere a real codebase would otherwise force a choice: TypeScript strict mode from commit 1, ESLint + Prettier from commit 1, Prisma as the only DB access path (no raw SQL escape hatches except migrations), and a single Next.js app (no separate backend service) with a clearly isolated `src/server/` layer so the "Node API layer" requirement is met without provisioning a second deployable.

No further reconciliation work is needed before implementation starts — the next phase (Phase 3, see §8) can scaffold directly.

---

## 2. Stack Decisions and Rationale

### 2.1 Framework & language
Next.js (App Router) + TypeScript + React + Tailwind CSS, as mandated. Server Actions are used for same-origin mutations invoked from React (compose message, assign conversation, update settings); Route Handlers (`src/app/api/**/route.ts`) are used for anything that must be a stable, independently-callable HTTP contract: all webhooks (Telegram/WhatsApp/Android gateway), the Android gateway's polling/ack endpoints, and any endpoint intended for future non-browser clients. Both call into a shared `src/server/services/*` layer — this is the "clearly separated Node API layer": Server Actions and Route Handlers are thin adapters that parse/validate input with Zod and delegate to the same service functions, so business logic is never duplicated between the two entry points.

### 2.2 Auth provider — **Auth.js (NextAuth v5)**, chosen over Clerk and Supabase Auth

**Decision: Auth.js with the Prisma adapter**, Credentials (email+password) provider plus an Email (magic link) provider, JWT session strategy carrying `organizationId` and `role` as custom claims.

**Why, against the explicit tradeoff the brief asks to weigh:**
- *Self-hosting / no vendor lock-in* is weighted heavily here because this is a fresh **multi-tenant SaaS** where org-scoping and role enforcement are core product requirements, not incidental. Auth.js stores users, sessions, and org/role membership in the *same* Postgres database as every other tenant-scoped row. That means org isolation can be enforced with ordinary Prisma queries and, if desired later, Postgres Row-Level Security — there is no second system-of-record for identity that has to be kept in sync with `Organization`/`User`/`Role`.
- Clerk and Supabase Auth are both excellent and faster to bootstrap (prebuilt UI, hosted session management, social login out of the box), but both push organization/role modeling into their own hosted constructs (Clerk Organizations, Supabase's separate auth schema) which then has to be mirrored into our Prisma `Organization`/`User`/`Role` models anyway to satisfy the required schema — that's double-modeling the same concept. They also introduce a hard external dependency and recurring cost for a project whose stated goal is a self-hostable platform.
- **Tradeoff accepted:** Auth.js requires us to hand-build the UI for sign-in, password reset, and magic-link request/consumption screens, and to implement password hashing (bcrypt/argon2) and rate-limiting on auth endpoints ourselves — Clerk/Supabase would give this for free. We accept this cost because it is a bounded, well-understood amount of work (covered explicitly in Phase 3), and in exchange we get zero vendor lock-in, no per-MAU billing, and a session model that is trivially extensible to add custom claims (`organizationId`, `role`, `teamIds`) needed by every authorization check in the app.
- Session strategy: JWT (not database sessions) so that Route Handlers and Server Actions can authorize requests without an extra DB round trip per request; a `Session` model is still kept in Prisma (Auth.js Prisma adapter requirement) primarily for the OAuth/Email-provider flows and for a future "revoke all sessions" admin action.

### 2.3 Translation provider — **OpenAI API**, chosen over Google Cloud Translation and DeepL

**Decision:** implement `OpenAiTranslationProvider` as the one real, wired-up `TranslationProvider`; Google Translate and DeepL remain documented, swappable, *unimplemented* options behind the same interface (their env vars are reserved but the app must run with only `OPENAI_API_KEY` set, or none at all in a `NoopTranslationProvider` used for local dev/tests).

**Why:**
- The workflow needs **both** `detectLanguage` and context-aware `translate` with glossary/entity preservation (names, addresses, URLs, phone numbers, dates, prices, IDs) on short, informal chat messages. A general-purpose LLM does all of this in a single call with a JSON-schema-constrained response (`response_format: json_schema`, strict mode), which maps directly onto our Zod output schema (`{ translatedText, sourceLanguage, targetLanguage, confidence, notes? }`) — one round trip instead of a detect call + a translate call.
- Dedicated NMT engines (DeepL, Google Cloud Translation) are typically *more* consistent for long-form, formal text, but are weaker at the specific things this product needs: DeepL only covers ~30 languages (too narrow for a "universal" messaging layer meant to serve arbitrary Telegram/WhatsApp/SMS contacts worldwide) and its glossary feature only works for a subset of language pairs. Google Cloud Translation covers far more languages and has a real glossary feature, but entity preservation (don't translate a phone number, keep a proper name intact, don't reformat a price) is harder to guarantee through its API surface than through an explicit instruction to an LLM.
- **Tradeoffs accepted and documented:** (a) OpenAI has no native "confidence score" the way some NMT vendors expose — we ask the model to self-report a 0–1 confidence in its structured output and store it as `translationConfidence`, but flag in the UI and in this plan that it is a heuristic, not a calibrated metric; (b) per-message latency and cost are higher than a dedicated NMT call at scale — acceptable for an MVP inbox workload (chat messages are short) and mitigated by keeping prompts small and by not re-translating on retry unless the source text changed; (c) output is technically non-deterministic — mitigated with `temperature: 0` and by storing the exact input/output pair on the `Message` row for auditability.
- The `TranslationProvider` interface is provider-agnostic by construction (see §3.3), so swapping in `GoogleTranslateProvider` or `DeepLProvider` later is an isolated, additive change — this is why `GOOGLE_TRANSLATE_API_KEY` and `DEEPL_API_KEY` are reserved in `.env.example` from day one even though unused.

### 2.4 Database & ORM
PostgreSQL + Prisma, as mandated. **Dev environment:** `docker-compose.yml` runs a local `postgres:16` container; `DATABASE_URL` points at it, `DIRECT_URL` is identical in dev (no pooler). **Assumed production hosting:** a managed Postgres with a connection pooler in front of it (Neon or Supabase Postgres are the two candidates called out for `DIRECT_URL`'s existence — that env var name is the standard Prisma convention for "bypass the pooler for migrations"). This plan does not commit to one now; it is a Phase 12 / deployment-time decision, since either works unmodified with the schema below. Migrations run via `prisma migrate deploy` in CI/CD, `prisma migrate dev` locally. A `prisma/seed.ts` populates one demo organization, a full set of five role users, a handful of contacts across all three active channels, and sample conversations/messages so the UI is populated immediately after `npm run db:seed`.

### 2.5 Validation, logging, error handling
- **Zod** validates every external input: all Route Handler request bodies/query params, all Server Action arguments, and process env at boot (`src/server/env.ts` parses `process.env` through a Zod schema and throws a descriptive startup error if a required var is missing — with adapter-specific vars only required when that adapter's `*_ENABLED` flag is true; see §6.7).
- **Structured logging** via `pino`, one logger instance (`src/server/logger.ts`), JSON output, `LOG_LEVEL` env-controlled, every log line carries `organizationId`, `requestId`, and (when applicable) `conversationId`/`messageId` for traceability, with a request-id middleware that stamps every inbound HTTP request.
- **Centralized error handling**: a single `AppError` class hierarchy (`NotFoundError`, `ForbiddenError`, `ValidationError`, `ConflictError`, `UpstreamAdapterError`) thrown by services; a shared `handleRouteError()` helper (used by every Route Handler) and a shared Server Action error boundary convert these into safe, generic client-facing messages while the full error (with stack) goes to the structured logger — never to the client (see §6).

---

## 3. Architecture

### 3.1 High-level diagram (text)

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              Next.js App                                │
│                                                                           │
│  ┌───────────────┐   ┌────────────────────┐   ┌────────────────────┐    │
│  │  UI (App       │   │  Server Actions     │   │  Route Handlers    │    │
│  │  Router pages, │──▶│  (mutations from    │   │  (webhooks, gateway│    │
│  │  React,        │   │  the browser)       │   │  polling, health)  │    │
│  │  Tailwind)     │   └─────────┬──────────┘   └──────────┬──────────┘    │
│  └───────────────┘             │                          │              │
│                                 ▼                          ▼              │
│                        ┌──────────────────────────────────────────┐      │
│                        │        src/server/services/*             │      │
│                        │  (auth guard, org-scoping, Zod-validated  │      │
│                        │   business logic — the "Node API layer")  │      │
│                        └───────────┬─────────────┬────────────────┘      │
│                                    ▼             ▼                        │
│                     ┌──────────────────┐  ┌────────────────────────┐     │
│                     │ TranslationEngine │  │ ChannelAdapter registry │     │
│                     │ (provider-agnostic)│  │ (Telegram / Android /   │     │
│                     └─────────┬─────────┘  │  WhatsApp / stubs)      │     │
│                               ▼             └───────────┬────────────┘     │
│                     ┌──────────────────┐                 ▼                │
│                     │ OpenAI API        │      Telegram Bot API /          │
│                     └──────────────────┘      Android device HTTP /        │
│                                                WhatsApp Cloud API           │
│                        ▼                                                  │
│              ┌────────────────────┐                                       │
│              │  Prisma → Postgres  │  (org-scoped everywhere)              │
│              └────────────────────┘                                       │
└─────────────────────────────────────────────────────────────────────────┘
```

External actors: Telegram Bot API (pushes webhooks to us, we push via sendMessage), Meta WhatsApp Cloud API (webhooks + Graph API calls), an Android device running a companion gateway app (polls our API for pending outbound SMS and pushes inbound SMS to us over HTTP), and end users (platform staff) via browser.

### 3.2 Channel-adapter architecture

Single interface, one file per adapter, all implementing:

```ts
// src/server/channels/types.ts
export interface NormalizedInboundMessage {
  externalContactId: string;
  externalUsername?: string;
  phoneNumber?: string;
  externalMessageId: string;
  externalReplyToId?: string;
  text: string;
  sentAt: Date;
  raw: unknown; // stored on MessageEvent.payload for audit/debugging
}

export interface SendMessageInput {
  channelAccount: ChannelAccount;
  externalContactId: string;
  text: string;
  replyToExternalId?: string;
}

export interface SendMessageResult {
  externalMessageId: string;
  status: "SENT" | "QUEUED"; // adapters never claim "DELIVERED" — that's an async event
}

export interface DeliveryStatusUpdate {
  externalMessageId: string;
  status: "SENT" | "DELIVERED" | "READ" | "FAILED";
  failureReason?: string;
  occurredAt: Date;
}

export interface MessagingChannelAdapter {
  readonly channelType: ChannelType;
  sendMessage(input: SendMessageInput): Promise<SendMessageResult>;
  validateWebhook?(req: Request): Promise<boolean>;
  parseInboundWebhook?(req: Request): Promise<NormalizedInboundMessage[]>;
  getDeliveryStatus?(externalMessageId: string): Promise<DeliveryStatusUpdate | null>;
  healthCheck(): Promise<{ healthy: boolean; detail?: string }>;
}
```

A `ChannelAdapterRegistry` (`src/server/channels/registry.ts`) maps `ChannelType → MessagingChannelAdapter`, built once at boot from parsed env (each adapter is only registered if its `*_ENABLED` flag — or presence of required config, for Telegram which has no explicit flag — is true). Route Handlers for webhooks look up the adapter by channel type and delegate; they never talk to Telegram/Meta/the device HTTP APIs directly.

- **TelegramAdapter** — fully functional. Uses Telegram Bot API `sendMessage` for outbound; webhook validation via the `X-Telegram-Bot-Api-Secret-Token` header compared to `TELEGRAM_WEBHOOK_SECRET`; `parseInboundWebhook` normalizes Telegram `Update` payloads (message, edited_message) into `NormalizedInboundMessage[]`.
- **AndroidSmsAdapter** — fully functional, but inverted control flow: the Android device is the channel, not a cloud API we call. `sendMessage` does **not** call an external HTTP API — it enqueues a row the device will later pull via `GET /api/gateways/messages/pending` and only becomes `SENT` once the device calls `POST /api/gateways/messages/:id/acknowledge` with the device's own SMS-send confirmation. Inbound SMS arrives via the device `POST`ing to `/api/gateways/inbound`. Every gateway request is authenticated with a per-device signed, revocable token (`ANDROID_GATEWAY_SIGNING_SECRET` signs a device-specific token issued at registration; see §6.3). Explicitly **not** Twilio/Telnyx/Vonage — there is no cloud SMS vendor in this path.
- **WhatsAppAdapter** — production-shaped: Graph API calls for outbound, `X-Hub-Signature-256` HMAC validation (using `WHATSAPP_APP_SECRET`) on inbound webhooks, the GET-verify-token handshake (`WHATSAPP_VERIFY_TOKEN`) for webhook registration. Gated entirely behind `WHATSAPP_ENABLED` — when false (default), the adapter is not registered, its route handlers return `404`/no-op, and **zero** WhatsApp env vars are required for the app to boot or for `env.ts` validation to pass.
- **MessengerAdapter / InstagramAdapter / EmailAdapter** — placeholder classes implementing the interface with `sendMessage`/`parseInboundWebhook` throwing `NotImplementedError`, registered but flagged `status: "PENDING_SETUP"` on `ChannelAccount`, so the Settings UI can list them as "coming soon" without special-casing the type elsewhere.

### 3.3 Translation-engine architecture

```ts
// src/server/translation/types.ts
export interface DetectLanguageResult {
  language: string; // BCP-47 code, e.g. "es", "pt-BR"
  confidence: number; // 0–1
}

export interface TranslateInput {
  text: string;
  sourceLanguage?: string; // omit to let the provider detect
  targetLanguage: string;
  glossary?: { term: string; translation: string }[];
}

export interface TranslateResult {
  translatedText: string;
  sourceLanguage: string;
  targetLanguage: string;
  confidence: number;
  provider: "openai" | "google" | "deepl" | "noop";
}

export interface TranslationProvider {
  readonly name: TranslateResult["provider"];
  detectLanguage(text: string): Promise<DetectLanguageResult>;
  translate(input: TranslateInput): Promise<TranslateResult>;
}
```

- `TranslationEngine` (`src/server/translation/engine.ts`) is the only consumer other services call. It resolves the active provider from `TRANSLATION_PROVIDER` (`"openai" | "google" | "deepl" | "noop"`), loads applicable `TranslationGlossary` rows for the org+language pair, and merges glossary terms into `TranslateInput.glossary` before calling the provider.
- `OpenAiTranslationProvider` (the one real implementation) sends a single chat completion with a strict JSON schema response containing `translatedText`, `sourceLanguage` (if not supplied), `confidence`, and calls out in its system prompt: preserve names, addresses, URLs, phone numbers, dates/times, prices, and IDs verbatim; apply glossary terms exactly; do not add commentary.
- `NoopTranslationProvider` echoes input text with `confidence: 0` and `sourceLanguage = targetLanguage` — used in local dev/tests when no API key is configured, so the whole message pipeline is exercisable without external calls.
- `GoogleTranslateProvider` / `DeepLProvider` are stubbed (throw `NotConfiguredError` with a clear message) — present to prove the interface truly supports swapping, not implemented in the MVP.

### 3.4 Language-priority resolution

Single pure function, unit-tested in isolation, used by both inbound and outbound flows:

```ts
// src/server/translation/resolveLanguage.ts
function resolveTargetLanguage(ctx: {
  conversationOverride?: string | null;
  contactPreferred?: string | null;
  contactDetected?: string | null;
  orgDefault: string;
}): string {
  return (
    ctx.conversationOverride ??
    ctx.contactPreferred ??
    ctx.contactDetected ??
    ctx.orgDefault ??
    "en"
  );
}
```

Priority order, exactly as specified: (1) `Conversation.preferredLanguageOverride`, (2) `Contact.preferredLanguage`, (3) `Contact.detectedLanguage`, (4) `Organization.defaultLanguage`, (5) hardcoded `"en"` fallback. This same function determines "what language should the contact receive" (outbound target) and, mirrored, "what language should the user's inbox show" (inbound target — normally the assigned user's `preferredLanguage`, falling back through the same chain with the org default and `"en"`).

### 3.5 Inbound message request lifecycle

1. **Receive**: channel-specific Route Handler (`/api/channels/telegram/webhook`, `/api/channels/whatsapp/webhook`, `/api/gateways/inbound`) receives the raw request.
2. **Validate source**: adapter's `validateWebhook()` — Telegram secret token header, WhatsApp `X-Hub-Signature-256` HMAC, Android gateway per-device signed token. Invalid → `401`, logged, no DB write.
3. **Normalize**: adapter's `parseInboundWebhook()` → `NormalizedInboundMessage[]`.
4. **Dedupe**: compute `idempotencyKey = sha256(channelAccountId + ":" + externalMessageId)`; if a `Message` with that `(organizationId, idempotencyKey)` already exists, short-circuit with `200 OK` (webhook senders retry aggressively; we must be idempotent) and log a `duplicate_webhook_ignored` event — no second write.
5. **Identify**: resolve `ChannelAccount` (from the webhook path/route or, for WhatsApp, the `phone_number_id` in the payload); resolve or create `Contact` + `ContactChannelIdentity` (match on `channelAccountId + externalContactId`; if new, create `Contact` with `preferredLanguage` unset); resolve or create the canonical `Conversation` for `(contactId, channelAccountId)`.
6. **Detect sender language** if `Contact.preferredLanguage` is not yet set: `TranslationEngine.detectLanguage(text)`, store into `Contact.detectedLanguage`.
7. **Resolve receiver's language**: the assigned user's `preferredLanguage` (§3.4 chain), defaulting to the org default if unassigned.
8. **Translate**: `TranslationEngine.translate({ text, sourceLanguage: resolved sender language, targetLanguage: resolved receiver language, glossary })`.
9. **Store**: one `Message` row — `originalText`, `translatedText`, `sourceLanguage`, `targetLanguage`, `translationProvider`, `translationConfidence`, `channelType`, `externalMessageId`, `status: "DELIVERED"` (inbound messages are already delivered to us by definition), plus a `MessageEvent` of type `received`. `Conversation.lastMessageAt` bumped in the same transaction.
10. **Display**: inbox/conversation views render `translatedText` by default with a "show original" toggle revealing `originalText` — no re-fetch needed, both are already stored.

### 3.6 Outbound message request lifecycle

1. **Compose**: user writes in their own `preferredLanguage` via the conversation view (Server Action `sendMessage`), with an optional client-generated idempotency key (also regenerated server-side as a fallback) to protect against double-submit/network retry.
2. **Resolve recipient's language**: §3.4 chain, target = contact's resolved language for this conversation.
3. **Translate**: `TranslationEngine.translate(...)`, instructed to preserve entities and apply any matching `TranslationGlossary`. Result stored immediately as `status: "PENDING"` **before** any send attempt — this row is the durable record even if the adapter call fails.
4. **Review-before-send** (if the org/user setting is on): the translated draft is shown to the user for confirmation/edit prior to send; an edit here sets `translationEdited: true` on the eventual message and is recorded as an audit-logged event, not a silent overwrite.
5. **Send via adapter**: `adapter.sendMessage(...)`. The message is only ever marked `"SENT"` after the adapter call *returns success with an external id* — never optimistically. A network/adapter error at this step leaves the message in `"PENDING"`/moves it to `"FAILED"` (see retry below) — the UI never claims the contact received something we haven't confirmed.
6. **Persist external id**: `externalMessageId` set from the adapter's response; a `MessageEvent` of type `sent` recorded.
7. **Track delivery**: subsequent channel webhooks (delivery receipts) or gateway acknowledgements move status forward: `SENT → DELIVERED → READ`, each transition recorded as its own `MessageEvent` (idempotent on `(messageId, eventType, externalEventId)`).
8. **Retry transient failures**: failures are classified `transient` (timeouts, 5xx, rate limits) vs `permanent` (invalid recipient, permanently blocked, malformed payload). Transient failures are retried with bounded exponential backoff (base 2s, cap 5 attempts, jittered) via a small in-process/DB-backed job queue (`MessageEvent` rows of type `retry_scheduled` drive a polling worker — see Phase 9/11 note on whether a dedicated queue like BullMQ is warranted; MVP starts with a Postgres-polled queue to avoid adding Redis as a hard dependency, documented as a scaling risk in §7). After the attempt cap, status moves to `"DEAD_LETTER"`/`"FAILED"` with `failureReason` populated and surfaced in the inbox as an explicit "retry" action for a human.
9. **Prevent duplicate sends**: the `idempotencyKey` unique constraint on `Message` is the hard backstop — a retried Server Action/API call with the same key updates the existing row's status rather than inserting a new message.

---

## 4. Prisma Schema

Design notes before the schema:
- **Every tenant-scoped model carries `organizationId`** (denormalized even where it's derivable through a relation, e.g. `Message.organizationId` could be reached via `Conversation` — it is kept directly on `Message` and `MessageEvent`'s parent anyway) specifically so every Prisma query can filter `where: { organizationId }` without a join, and so a composite index `@@index([organizationId, ...])` is always available. This is the backbone of org isolation (§6.1).
- **Idempotency/dedup** lives entirely in one column: `Message.idempotencyKey`, unique per organization. Inbound dedup key = `sha256(channelAccountId:externalMessageId)`; outbound dedup key = a UUID generated client-side (compose form) or server-side as a fallback. This single mechanism satisfies both "don't double-process a retried webhook" and "don't double-send a retried compose action."
- **Cascade choices**: hard `onDelete: Cascade` is used only where the child record is meaningless without the parent and parent deletion is itself a rare, admin-gated action (e.g. deleting an `Organization` cascades everything — but the product never exposes "delete organization" as a routine action; it is an off-path admin/compliance operation). Where a delete could otherwise silently destroy audit-relevant history (e.g. deleting a `User` who has assigned conversations), the FK uses `onDelete: SetNull` instead, so history survives with `assignedUserId: null`.
- **Soft-delete over hard-delete** for `Contact`, `Conversation`, `ChannelAccount`: these use a `status`/`archived` field rather than row deletion, since "archive" is an explicit product requirement (Contacts CRUD spec says "archive", not "delete") and message history must remain queryable for audit.

```prisma
// prisma/schema.prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider  = "postgresql"
  url       = env("DATABASE_URL")
  directUrl = env("DIRECT_URL")
}

// ---------- Enums ----------

enum Role {
  OWNER
  ADMINISTRATOR
  MANAGER
  AGENT
  VIEWER
}

enum TeamRole {
  LEAD
  MEMBER
}

enum ChannelType {
  TELEGRAM
  ANDROID_SMS
  WHATSAPP
  MESSENGER
  INSTAGRAM
  EMAIL
}

enum ChannelAccountStatus {
  PENDING_SETUP
  ACTIVE
  DISABLED
  ERROR
}

enum ConversationStatus {
  OPEN
  PENDING
  RESOLVED
  ARCHIVED
}

enum SenderType {
  CONTACT
  USER
  SYSTEM
}

enum MessageDirection {
  INBOUND
  OUTBOUND
}

enum MessageStatus {
  QUEUED
  PENDING
  SENT
  DELIVERED
  READ
  FAILED
  DEAD_LETTER
}

// ---------- Core tenancy ----------

model Organization {
  id              String   @id @default(cuid())
  name            String
  defaultLanguage String   @default("en")
  timezone        String   @default("UTC")
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  users                 User[]
  teams                 Team[]
  contacts              Contact[]
  channelAccounts       ChannelAccount[]
  conversations         Conversation[]
  messages              Message[]
  translationGlossaries TranslationGlossary[]
  auditLogs             AuditLog[]

  @@index([name])
}

model User {
  id                String    @id @default(cuid())
  organizationId    String
  name              String
  email             String
  preferredLanguage String    @default("en")
  role              Role      @default(AGENT)
  // Auth.js (Credentials + Email provider) support fields:
  passwordHash      String?
  image             String?
  emailVerified     DateTime?
  createdAt         DateTime  @default(now())
  updatedAt         DateTime  @updatedAt

  organization          Organization   @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  teamMemberships       TeamMember[]
  assignedConversations Conversation[] @relation("ConversationAssignedUser")
  auditLogs             AuditLog[]
  sessions              Session[]
  accounts              Account[]

  @@unique([organizationId, email])
  @@index([organizationId])
}

// Auth.js Prisma adapter models
model Account {
  id                String  @id @default(cuid())
  userId            String
  type              String
  provider          String
  providerAccountId String
  refresh_token     String? @db.Text
  access_token      String? @db.Text
  expires_at        Int?
  token_type        String?
  scope             String?
  id_token          String? @db.Text
  session_state     String?

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([provider, providerAccountId])
  @@index([userId])
}

model Session {
  id           String   @id @default(cuid())
  sessionToken String   @unique
  userId       String
  expires      DateTime

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId])
}

model VerificationToken {
  identifier String
  token      String   @unique
  expires    DateTime

  @@unique([identifier, token])
}

// ---------- Teams ----------

model Team {
  id             String   @id @default(cuid())
  organizationId String
  name           String
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt

  organization  Organization   @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  members       TeamMember[]
  conversations Conversation[] @relation("ConversationAssignedTeam")

  @@unique([organizationId, name])
  @@index([organizationId])
}

model TeamMember {
  teamId    String
  userId    String
  role      TeamRole @default(MEMBER)
  createdAt DateTime @default(now())

  team Team @relation(fields: [teamId], references: [id], onDelete: Cascade)
  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@id([teamId, userId])
  @@index([userId])
}

// ---------- Contacts & channels ----------

model Contact {
  id                String    @id @default(cuid())
  organizationId    String
  displayName       String
  preferredLanguage String?
  detectedLanguage  String?
  phoneNumber       String?
  email             String?
  notes             String?
  archivedAt        DateTime?
  createdAt         DateTime  @default(now())
  updatedAt         DateTime  @updatedAt

  organization  Organization             @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  identities    ContactChannelIdentity[]
  conversations Conversation[]

  @@unique([organizationId, phoneNumber])
  @@index([organizationId])
  @@index([organizationId, displayName])
}

model ChannelAccount {
  id                   String               @id @default(cuid())
  organizationId       String
  channelType          ChannelType
  displayName          String
  externalAccountId    String?
  // Reference to a secret in the encryption/secrets layer — never the raw credential.
  // See security section (6.6) for the production encryption plan.
  credentialRef        String?
  status               ChannelAccountStatus @default(PENDING_SETUP)
  createdAt            DateTime             @default(now())
  updatedAt            DateTime             @updatedAt

  organization  Organization             @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  identities    ContactChannelIdentity[]
  conversations Conversation[]

  @@unique([organizationId, channelType, externalAccountId])
  @@index([organizationId])
}

model ContactChannelIdentity {
  id                String   @id @default(cuid())
  contactId         String
  channelAccountId  String
  externalContactId String
  externalUsername  String?
  phoneNumber       String?
  metadata          Json?
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt

  contact        Contact        @relation(fields: [contactId], references: [id], onDelete: Cascade)
  channelAccount ChannelAccount @relation(fields: [channelAccountId], references: [id], onDelete: Cascade)

  @@unique([channelAccountId, externalContactId])
  @@index([contactId])
}

// ---------- Conversations & messages ----------

model Conversation {
  id                       String              @id @default(cuid())
  organizationId           String
  contactId                String
  channelAccountId         String
  assignedUserId           String?
  assignedTeamId           String?
  preferredLanguageOverride String?
  status                   ConversationStatus  @default(OPEN)
  lastMessageAt            DateTime?
  createdAt                DateTime            @default(now())
  updatedAt                DateTime            @updatedAt

  organization   Organization    @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  contact        Contact         @relation(fields: [contactId], references: [id], onDelete: Cascade)
  channelAccount ChannelAccount  @relation(fields: [channelAccountId], references: [id], onDelete: Cascade)
  assignedUser   User?           @relation("ConversationAssignedUser", fields: [assignedUserId], references: [id], onDelete: SetNull)
  assignedTeam   Team?           @relation("ConversationAssignedTeam", fields: [assignedTeamId], references: [id], onDelete: SetNull)
  messages       Message[]

  @@unique([contactId, channelAccountId])
  @@index([organizationId, status, lastMessageAt])
  @@index([assignedUserId])
  @@index([assignedTeamId])
}

model Message {
  id                    String            @id @default(cuid())
  organizationId        String
  conversationId        String
  senderType            SenderType
  direction             MessageDirection
  originalText          String
  translatedText        String?
  sourceLanguage        String?
  targetLanguage        String?
  translationProvider   String?
  translationConfidence Float?
  translationEdited     Boolean           @default(false)
  channelType           ChannelType
  externalMessageId     String?
  externalReplyToId     String?
  status                MessageStatus     @default(QUEUED)
  failureReason         String?
  idempotencyKey        String
  isInternalNote        Boolean           @default(false)
  createdAt             DateTime          @default(now())
  updatedAt             DateTime          @updatedAt

  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  conversation Conversation @relation(fields: [conversationId], references: [id], onDelete: Cascade)
  events       MessageEvent[]

  @@unique([organizationId, idempotencyKey])
  @@index([conversationId, createdAt])
  @@index([organizationId, status])
  @@index([externalMessageId])
}

model MessageEvent {
  id             String   @id @default(cuid())
  messageId      String
  eventType      String   // e.g. "received" | "sent" | "delivered" | "read" | "failed" | "retry_scheduled" | "duplicate_webhook_ignored"
  externalEventId String?
  payload        Json?
  createdAt      DateTime @default(now())

  message Message @relation(fields: [messageId], references: [id], onDelete: Cascade)

  @@unique([messageId, eventType, externalEventId])
  @@index([messageId, createdAt])
}

// ---------- Glossaries & audit ----------

model TranslationGlossary {
  id             String   @id @default(cuid())
  organizationId String
  name           String
  sourceLanguage String
  targetLanguage String
  terms          Json     // [{ term: string; translation: string; notes?: string }]
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt

  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  @@unique([organizationId, name])
  @@index([organizationId, sourceLanguage, targetLanguage])
}

model AuditLog {
  id             String   @id @default(cuid())
  organizationId String
  userId         String?
  action         String
  entityType     String
  entityId       String
  metadata       Json?
  createdAt      DateTime @default(now())

  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  user         User?        @relation(fields: [userId], references: [id], onDelete: SetNull)

  @@index([organizationId, createdAt])
  @@index([entityType, entityId])
}
```

**Dev seed (`prisma/seed.ts`, Phase 3 deliverable):** one `Organization` ("Acme Demo Co", `defaultLanguage: "en"`), five `User`s (one per role), one `Team` with mixed membership, three `ChannelAccount`s (Telegram active, Android SMS active, WhatsApp `PENDING_SETUP` since disabled by default), 6–8 `Contact`s with varied `preferredLanguage`, a handful of `Conversation`s each with a short back-and-forth `Message` history including at least one `FAILED` and one `DEAD_LETTER` example so the retry UI has something to show immediately.

---

## 5. API Route Inventory

All routes are namespaced under `/api/...` for Route Handlers; anything marked "Server Action" is a `"use server"` function called directly from a React component instead of a fetch call, but is listed here for completeness since it is part of the same authorized service layer. **Auth requirement legend:** `Session` = any authenticated user; `Session+Role(X+)` = authenticated and role ≥ X in the standard `OWNER > ADMINISTRATOR > MANAGER > AGENT > VIEWER` ordering; `Webhook-Signed` = no user session, but adapter-specific signature/secret validation required; `Public` = no auth (health checks only).

| Area | Method & Path | Purpose | Auth | Validation notes |
|---|---|---|---|---|
| Contacts | Server Action `createContact` | Create a contact | Session+Role(Agent+) | Zod: displayName required; phone/email optional but ≥1 recommended |
| Contacts | Server Action `getContact` / `GET /api/contacts/:id` | Read one contact + identities + recent conversations | Session | org-scope enforced |
| Contacts | Server Action `listContacts` | List/search/filter contacts | Session | Zod query schema: search, channel, language, archived |
| Contacts | Server Action `updateContact` | Update fields (name, notes, etc.) | Session+Role(Agent+) | partial Zod schema |
| Contacts | Server Action `archiveContact` | Soft-delete (set `archivedAt`) | Session+Role(Manager+) | audit-logged |
| Contacts | Server Action `setContactLanguage` | Set `preferredLanguage` explicitly | Session+Role(Agent+) | Zod BCP-47 language code validator; audit-logged |
| Contacts | Server Action `connectChannelIdentity` | Link a `ContactChannelIdentity` to a contact (merge duplicate identities) | Session+Role(Manager+) | validates channelAccount belongs to same org |
| Conversations | `GET /api/conversations` | Inbox list (filters: channel, language, assignee, status, unread) | Session | Zod query schema; always `where: { organizationId }` |
| Conversations | `GET /api/conversations/:id` | Full conversation + messages | Session | org + (role-based) assignment visibility check |
| Conversations | Server Action `assignConversation` | Assign to user/team | Session+Role(Agent+) | must be same-org user/team; audit-logged |
| Conversations | Server Action `changeConversationStatus` | Open/Pending/Resolved/Archived | Session+Role(Agent+) | enum validated |
| Conversations | Server Action `setConversationLanguageOverride` | Set `preferredLanguageOverride` | Session+Role(Agent+) | audit-logged |
| Conversations | Server Action `addInternalNote` | Add a `Message` with `isInternalNote: true` (never sent externally) | Session+Role(Agent+) | never touches adapter/translation |
| Messages | `GET /api/conversations/:id/messages` | Paginated message list | Session | cursor-based pagination Zod schema |
| Messages | Server Action `sendMessage` | Compose + translate + send outbound | Session+Role(Agent+) | Zod: text non-empty, idempotencyKey uuid; runs full outbound lifecycle (§3.6) |
| Messages | Server Action `retryMessage` | Re-attempt a `FAILED`/`DEAD_LETTER` message | Session+Role(Agent+) | only allowed on terminal-failed states; audit-logged |
| Messages | Server Action `revealOriginal` | Client-side toggle only — no server call needed (`originalText` already in payload); listed for completeness of "reveal original" requirement | Session | n/a |
| Messages | Server Action `recordTranslationEdit` | Persist a user edit to `translatedText` pre-send | Session+Role(Agent+) | sets `translationEdited: true`; audit-logged |
| Telegram | `POST /api/channels/telegram/webhook` | Inbound updates from Telegram | Webhook-Signed (secret token header) | validates `X-Telegram-Bot-Api-Secret-Token`; body loosely validated then normalized |
| Telegram | Server Action `getTelegramWebhookConfig` | Returns the webhook URL + secret-setup instructions for admin to register with BotFather/`setWebhook` | Session+Role(Administrator+) | read-only helper, no external call unless "register" is explicitly clicked |
| Telegram | `GET /api/channels/telegram/health` | Connection health (last webhook received, bot getMe check) | Session+Role(Administrator+) | calls adapter `healthCheck()` |
| Android Gateway | `POST /api/gateways/register` | Register a new Android device, issue a signed device token | Session+Role(Administrator+) | Zod: deviceName, phoneNumber; returns token once, never re-displayed |
| Android Gateway | `POST /api/gateways/heartbeat` | Device liveness ping | Webhook-Signed (device token) | updates `ChannelAccount.status` |
| Android Gateway | `POST /api/gateways/inbound` | Device pushes a received SMS | Webhook-Signed (device token) | Zod: from, text, sentAt, externalMessageId |
| Android Gateway | `GET /api/gateways/messages/pending` | Device polls for outbound SMS to send | Webhook-Signed (device token) | org/device-scoped query only |
| Android Gateway | `POST /api/gateways/messages/:id/acknowledge` | Device confirms it sent the SMS | Webhook-Signed (device token) | idempotent; sets `SENT` + `externalMessageId` |
| Android Gateway | `POST /api/gateways/messages/:id/fail` | Device reports send failure | Webhook-Signed (device token) | Zod: reason enum; triggers retry logic |
| WhatsApp | `GET /api/channels/whatsapp/webhook` | Meta's verify-token handshake | Public (verify token check) | only active if `WHATSAPP_ENABLED`; else `404` |
| WhatsApp | `POST /api/channels/whatsapp/webhook` | Inbound messages/status callbacks | Webhook-Signed (`X-Hub-Signature-256` HMAC via `WHATSAPP_APP_SECRET`) | only active if `WHATSAPP_ENABLED` |
| WhatsApp | `GET /api/channels/whatsapp/health` | Connection health | Session+Role(Administrator+) | no-op/"disabled" response if flag off |
| Admin | Server Action `listUsers` / `inviteUser` / `updateUserRole` / `deactivateUser` | User management | Session+Role(Administrator+) | role changes audit-logged; cannot self-demote last Owner |
| Admin | Server Action `createTeam` / `updateTeam` / `addTeamMember` / `removeTeamMember` | Team management | Session+Role(Manager+) for membership, Role(Administrator+) for create/delete |
| Admin | Server Action `getOrgSettings` / `updateOrgSettings` | Default language, timezone, translation provider selection, review-before-send default, data retention window | Session+Role(Administrator+) | audit-logged |
| Admin | Server Action `listGlossaries` / `createGlossary` / `updateGlossary` / `deleteGlossary` | Glossary CRUD | Session+Role(Manager+) | Zod validates `terms` array shape |
| Admin | `GET /api/admin/audit-log` | Paginated audit trail | Session+Role(Administrator+) | org-scoped, immutable, filter by entityType/date |
| System | `GET /api/health` | Liveness/readiness + per-adapter health summary | Public | no secrets in response body |
| Auth | `/api/auth/[...nextauth]` (Auth.js catch-all) | Sign-in, sign-out, magic-link callback, session | Public (endpoint) / establishes session | Auth.js internal validation + our Credentials provider Zod schema |

---

## 6. Security Model

### 6.1 Org isolation
Every Prisma query in `src/server/services/*` goes through a small set of **org-scoped repository functions** (e.g. `findConversation(orgId, id)`, never a bare `prisma.conversation.findUnique({ where: { id } })` reachable from a route). A lint rule / code-review checklist item (enforced in Phase 10) flags any direct `prisma.<model>.find*` call outside the repository layer. The authenticated session's `organizationId` is the only source of the org filter — it is never accepted from client input (body/query), preventing cross-tenant access via a forged `organizationId` field.

### 6.2 AuthN/AuthZ
Auth.js session (JWT) carries `userId`, `organizationId`, `role`. A single `requireRole(session, minRole)` guard (role ordering: `OWNER(4) > ADMINISTRATOR(3) > MANAGER(2) > AGENT(1) > VIEWER(0)`) is called at the top of every Server Action and Route Handler that mutates or reads sensitive data — enforced server-side per the requirement, not just hidden in the UI. `VIEWER` is read-only everywhere; only `AGENT+` can send messages or resolve conversations; only `MANAGER+` can archive contacts, manage glossaries, and manage team membership; only `ADMINISTRATOR+` can manage users, channel accounts, and org settings; `OWNER` is the only role that can transfer ownership or (eventually) delete the organization.

### 6.3 Webhook validation per channel
- **Telegram**: `X-Telegram-Bot-Api-Secret-Token` header must equal `TELEGRAM_WEBHOOK_SECRET` (set via `setWebhook`'s `secret_token` param at registration time).
- **WhatsApp**: `X-Hub-Signature-256` HMAC-SHA256 of the raw body using `WHATSAPP_APP_SECRET`, computed before JSON parsing (raw body must be preserved — Next.js Route Handlers read the raw stream for this).
- **Android gateway**: each device gets a signed token at `POST /api/gateways/register` (HMAC over `deviceId` using `ANDROID_GATEWAY_SIGNING_SECRET`); every subsequent device request includes the token, which is verified and checked against a revocation flag on the `ChannelAccount`; an admin can revoke a device from Settings, invalidating the token immediately without needing to rotate the shared signing secret.

### 6.4 Rate limiting
A shared in-process/DB-backed sliding-window limiter (upgradeable to Redis without an interface change) applied to: all public/webhook-adjacent endpoints (`/api/channels/*/webhook`, `/api/gateways/*`), the auth sign-in/magic-link-request endpoints (to blunt credential stuffing / email-bombing), and `POST /api/gateways/register`. Limits are per-IP for anonymous endpoints and per-`ChannelAccount`/device for authenticated-device endpoints. Exceeding the limit returns `429` with no detail beyond a generic message.

### 6.5 Idempotency & duplicate-webhook prevention
Covered in depth in §3.5/§4 — the `Message.idempotencyKey` unique constraint is the single enforcement point; both webhook replays and client double-submits collapse to the same "no-op, return current state" behavior instead of erroring or double-processing.

### 6.6 Encryption at rest — plan for production
MVP stores `ChannelAccount.credentialRef` as a reference (not the credential itself). **Production plan (documented here, not fully implemented as a hard MVP blocker, called out as a risk in §7):** channel credentials (bot tokens, WhatsApp access tokens, device signing material) are envelope-encrypted — a per-organization Data Encryption Key (DEK) generated at org creation, itself encrypted by a root Key Encryption Key (KEK) held in a managed KMS (AWS KMS/GCP KMS, chosen at deploy time, not before), with the encrypted DEK stored in `ChannelAccount` and the ciphertext blob in a dedicated `credentials` storage location (could be the same Postgres in a `bytea` column or an external secret store) — application code never handles the KEK directly, only calls the KMS `decrypt` API at the moment of adapter use, and the decrypted value is held in memory only for the duration of the API call. The same DEK-per-org approach is recommended for `Message.originalText`/`translatedText` if/when the product needs message-content-at-rest encryption beyond Postgres's own disk encryption (most managed Postgres already encrypts volumes at rest; the DEK-per-org layer is for defense-in-depth / customer-managed-key requirements, and is explicitly **out of scope for MVP** — flagged, not built).

### 6.7 Env var validation & zero-credential startup
`src/server/env.ts` parses `process.env` with a Zod schema at process boot (fails fast with a clear message listing exactly which vars are missing). Conditional requirement logic: `WHATSAPP_*` vars are `required_if(WHATSAPP_ENABLED === "true")`; `ANDROID_GATEWAY_SIGNING_SECRET` required only if `ANDROID_GATEWAY_ENABLED === "true"`; `TELEGRAM_*` required only if `TELEGRAM_ENABLED === "true"`. With every `*_ENABLED` flag left unset/false and only `DATABASE_URL`/`AUTH_SECRET`/`APP_URL` set, the app must boot cleanly (this is a Phase 3 acceptance test, not an afterthought).

### 6.8 Security headers, generic errors, audit log
Standard headers (`Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Content-Security-Policy` scoped to same-origin + the specific external hosts the UI actually needs, `Referrer-Policy: strict-origin-when-cross-origin`) set via Next.js middleware. All service-layer errors are wrapped so clients only ever see a safe, generic message (`"Something went wrong. Reference: <requestId>"`) while the structured logger captures the real error. `AuditLog` rows are written for every sensitive mutation: role changes, user invites/deactivation, channel account connect/disconnect/credential rotation, glossary changes, org settings changes, contact archive, conversation reassignment, translation edits, and message retries.

### 6.9 Translation-quality disclosure
A persistent, dismissible-but-re-shown banner and an explicit opt-in "high-risk conversation" flag (settable per-conversation) state that machine translation is imperfect and must not be relied upon for medical, legal, financial, or emergency communications; flagging a conversation as high-risk surfaces a stronger inline warning above the composer every time a message is sent in that thread.

---

## 7. Risks, Missing Dependencies, Compliance, and Required External Credentials

**Risks / open engineering questions carried forward, not resolved by this plan:**
- The MVP retry/backoff mechanism is Postgres-polled rather than a dedicated queue (Redis/BullMQ/SQS) to avoid a new infra dependency; this is fine at low volume but is a known scaling ceiling — revisit if outbound volume or retry cadence grows.
- LLM-based translation (OpenAI) has variable latency and non-deterministic edge cases; no SLA is assumed. `temperature: 0` reduces but does not eliminate variance.
- Production encryption-at-rest for message content (§6.6) is designed, not built, in this MVP — flagged as a pre-launch-hardening item for any deployment handling sensitive conversation content.
- Contact/conversation matching across channels (the same human messaging via both Telegram and SMS) is **not** attempted in MVP — each `ChannelAccount` identity is a distinct `Contact` unless manually merged via `connectChannelIdentity`; cross-channel identity resolution is a post-MVP feature.

**Compliance stance:** GDPR/CCPA-style data subject rights (access, deletion/erasure, portability) are **documented as an intended capability** (contact archive + org settings' data retention window are the initial building blocks) but this plan and its implementation are **not an independent compliance audit** — no claim of GDPR/CCPA/HIPAA compliance is made or should be inferred from this document or the resulting codebase. A real deployment handling EU/CA personal data needs a separate legal/compliance review before launch.

**External credentials a human must supply before each adapter goes live** (none of these can be generated by the implementation itself):
1. **Telegram** — a bot token from @BotFather (`TELEGRAM_BOT_TOKEN`), and the operator must choose/set a webhook secret value (`TELEGRAM_WEBHOOK_SECRET`) themselves (this one *is* self-generated, just needs to be set consistently on both our side and via `setWebhook`).
2. **Android SMS gateway** — no external vendor credential (the "credential" is the device itself and its SIM), but a human must generate and store `ANDROID_GATEWAY_SIGNING_SECRET` and physically install/register the companion Android app on the device that will act as the channel.
3. **WhatsApp Business Cloud API** — requires a Meta Business Manager account, a Meta App with WhatsApp product added and (for anything beyond a handful of test numbers) completed App Review/Business Verification, plus `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_BUSINESS_ACCOUNT_ID`, a self-chosen `WHATSAPP_VERIFY_TOKEN`, and `WHATSAPP_APP_SECRET` from the Meta App dashboard.
4. **Translation provider** — an `OPENAI_API_KEY` from the OpenAI platform (billing enabled on that account); `GOOGLE_TRANSLATE_API_KEY`/`DEEPL_API_KEY` are reserved for future providers and not required for MVP.

---

## 8. Milestones (Phases 3–12)

> Phases 1–2 (product definition, this planning document) precede this list and are already complete by the time this document exists.

### Phase 3 — Foundation
**Deliverables:** Next.js + TypeScript + Tailwind app scaffolded; ESLint/Prettier configured; `docker-compose.yml` for local Postgres; Prisma schema (§4) committed and migrated; `prisma/seed.ts` implemented; `src/server/env.ts` Zod env validation (with the zero-credential-boot behavior from §6.7); Auth.js wired with Credentials + Email providers and the Prisma adapter; base App Router layout with role-aware navigation shell; structured logging (`pino`) and the centralized `AppError`/`handleRouteError` pattern in place; CI pipeline running lint + typecheck + `prisma validate`.
**Definition of Done:** `npm run dev` boots with zero optional env vars set; a seeded user can sign in; `npm run db:seed` populates the demo data described in §4; CI is green on an empty-diff PR.

### Phase 4 — Translation engine
**Deliverables:** `TranslationProvider` interface, `TranslationEngine`, `OpenAiTranslationProvider` (real), `NoopTranslationProvider`, stub `GoogleTranslateProvider`/`DeepLProvider`; `resolveTargetLanguage` pure function with unit tests covering all five priority levels and their absence combinations; glossary loading/merging into translate calls; `TranslationGlossary` CRUD service functions (UI comes in Phase 10's Settings work, but the service + Zod schemas land here).
**Definition of Done:** given a fixed input and mocked OpenAI response, `TranslationEngine.translate()` returns a correctly-shaped `TranslateResult`; priority-resolution unit tests pass for all documented orderings; running with `TRANSLATION_PROVIDER=noop` and no API key produces deterministic passthrough output end-to-end.

### Phase 5 — Messaging core
**Deliverables:** `MessagingChannelAdapter` interface and registry; full `Conversation`/`Message`/`MessageEvent` service layer implementing the inbound (§3.5) and outbound (§3.6) lifecycles against a fake in-memory adapter (used purely for this phase's tests, not shipped); idempotency-key dedup logic; retry/backoff worker (Postgres-polled) with transient/permanent failure classification; internal-notes support (`isInternalNote`) kept fully separate from customer-facing sends.
**Definition of Done:** an end-to-end test sends a fake inbound message through detect→translate→store→display and a fake outbound message through compose→translate→"send"→status-track, using the fake adapter; a duplicate inbound webhook payload provably results in exactly one `Message` row; a simulated adapter failure is retried per the backoff policy and eventually reaches `DEAD_LETTER` with a populated `failureReason`.

### Phase 6 — Telegram
**Deliverables:** `TelegramAdapter` fully implemented (send, webhook validation, inbound normalization, health check); `/api/channels/telegram/webhook`, the webhook-config helper action, and `/api/channels/telegram/health` routes; Settings UI section to connect a Telegram bot and display connection health.
**Definition of Done:** against a real (or realistically mocked, if no live bot token is available in CI) Telegram Bot API, an inbound Telegram message flows into a translated inbox message and a composed reply is delivered back through the adapter with status tracked to at least `SENT`.

### Phase 7 — Shared inbox
**Deliverables:** Inbox list page (channel icon, contact name, preferred language, last message preview, assignment, unread count, delivery status, search, filters by channel/language/assignee/status/unread); Conversation view (original+translated toggle, direction/timestamps, translation status, delivery status, composer, target-language indicator, review-before-send toggle, retry action, conversation-language override, contact sidebar, assignment controls, internal notes UI clearly visually distinct from external messages); Contacts CRUD pages; Teams pages (create, add members, assign conversations, role-gated actions); Settings pages (org default language, translation provider selection, channel integrations list, review-before-send default, glossary management UI, data retention setting).
**Definition of Done:** every screen listed in the product brief exists and is navigable by an appropriately-role-authorized user; role-gated actions are verifiably blocked server-side (not just hidden) when tested with a lower-privileged session; all filters on the inbox function against seeded data.

### Phase 8 — Android gateway
**Deliverables:** `AndroidSmsAdapter`; `/api/gateways/register`, `/heartbeat`, `/inbound`, `GET /messages/pending`, `/messages/:id/acknowledge`, `/messages/:id/fail`; device token issuance/signing/revocation; Settings UI to register/revoke a device and view its heartbeat/health status. (The companion Android device app itself is a separate deliverable/binary outside this Next.js repo's scope — this phase delivers the **API contract** the device app integrates against, per the brief's "functional API + device integration contract" wording.)
**Definition of Done:** a scripted client simulating the Android app can register, heartbeat, poll pending messages, submit an inbound SMS, and acknowledge/fail an outbound send, all authenticated by its issued device token; a revoked device's subsequent requests are rejected.

### Phase 9 — WhatsApp readiness
**Deliverables:** `WhatsAppAdapter` (Graph API send, webhook GET-verify handshake, `X-Hub-Signature-256` validation, inbound normalization, status-callback handling); `/api/channels/whatsapp/webhook` (GET+POST) and `/health` routes; `WHATSAPP_ENABLED` feature flag wired through env validation, adapter registry, and route handlers so the entire surface is inert with zero WhatsApp env vars set.
**Definition of Done:** with `WHATSAPP_ENABLED=false` (default), the app boots with no WhatsApp env vars and the WhatsApp routes/adapter are provably inert (404 or explicit "disabled"); with the flag on and test credentials supplied, a signed test webhook payload is accepted and an unsigned/mis-signed one is rejected.

### Phase 10 — Review
**Deliverables:** cross-cutting audit against §6 (security model) and this plan generally: confirm org-scoping repository-layer discipline (§6.1) with a code-level check; confirm every sensitive mutation writes an `AuditLog` row; confirm rate limiting is applied to every public/webhook endpoint; confirm security headers are present; confirm the high-risk-conversation disclosure (§6.9) is implemented; fix gaps found.
**Definition of Done:** a written checklist (one line per §6 subsection) is checked off with evidence (test or manual verification note) for each item; no direct un-scoped Prisma call exists outside the repository layer.

### Phase 11 — Testing
**Deliverables:** Vitest unit tests for `resolveTargetLanguage`, translation provider adapters (mocked), channel adapter parsers/validators (mocked webhook payloads per channel), idempotency-key generation; React Testing Library tests for the Conversation view's original/translated toggle, review-before-send flow, and role-gated UI elements; route-handler-level API tests (using Next's route handler test utilities or supertest-style requests) for every route in §5, including negative cases (bad signature → 401, wrong role → 403, duplicate webhook → single row); Playwright e2e covering sign-in → inbox → open conversation → send message → see it translated and status-tracked, plus an admin-role e2e for user/team/glossary management.
**Definition of Done:** CI runs all four test layers on every PR; core lifecycle paths (§3.5, §3.6) have e2e coverage; no route in §5 lacks at least one authz-negative test.

### Phase 12 — Final review
**Deliverables:** full read-through of this plan against the actual implementation, noting any intentional deviations and why; `.env.example` finalized to mirror exactly the env vars in §9 below with inline comments explaining which are conditional; production deployment target decided (Neon vs Supabase vs self-managed Postgres) and documented; go-live checklist compiled from §7's "external credentials" list.
**Definition of Done:** a named reviewer signs off that the shipped app matches this plan's Phases 3–11 Definition-of-Done criteria; `.env.example` boots the app with only the unconditional vars set, verified once more as a final gate.

---

## 9. Testing Strategy

- **Unit (Vitest):** pure functions and isolated modules — language-priority resolution, idempotency-key derivation, Zod schemas (valid/invalid fixtures), translation provider request/response shaping (OpenAI client mocked, no live API calls in CI), channel adapter webhook parsers/validators against fixture payloads (a captured/representative Telegram `Update`, a WhatsApp webhook body, an Android gateway inbound payload) and their signature-validation logic (valid signature accepted, tampered payload rejected).
- **Integration (Vitest + a real test Postgres, e.g. via the same `docker-compose` service on a separate test database):** service-layer functions against the actual Prisma schema — creating a conversation end-to-end, the full inbound/outbound lifecycles (§3.5/§3.6) with the `NoopTranslationProvider` and a fake in-memory channel adapter, duplicate-webhook idempotency, retry/backoff state transitions, org-isolation checks (a query scoped to org A never returns org B's rows even when IDs are guessed).
- **API (route-handler level):** every route in §5 gets at least a happy-path test and the relevant negative tests (missing/invalid signature → 401, insufficient role → 403, malformed body → 400, duplicate idempotency key → idempotent 200). Run against the Next.js route handlers directly (no browser), using the test Postgres.
- **E2E (Playwright):** browser-driven flows — sign in, view inbox with filters, open a conversation, see original/translated toggle, compose and send with review-before-send on and off, retry a failed message, reassign a conversation, admin flows for user invite/role change and glossary creation, and an authorization e2e proving a `Viewer` cannot see/trigger role-gated controls even by direct navigation.
- **Component (React Testing Library):** conversation view sub-components (translation toggle, delivery-status badge, composer with target-language indicator) and inbox filter controls, isolated from full e2e overhead for fast feedback during development.
- CI runs unit + integration + API tests on every push; Playwright e2e runs on every PR against a fully seeded ephemeral environment (or nightly, if e2e runtime becomes a bottleneck — a call left to Phase 11 based on actual measured runtime).

---

## 10. Multi-Tenancy Stance

This is built as a **true multi-tenant SaaS from day one**, per the product owner's decision — not re-litigated here. Every tenant-scoped table carries `organizationId`; every service-layer query is org-scoped through the repository pattern in §6.1; `Organization` is the top-level isolation boundary for users, teams, contacts, channel accounts, conversations, messages, glossaries, and audit logs. There is no "single-tenant mode" or shared-across-orgs data path anywhere in the design — a future customer-managed-database or dedicated-instance deployment model would be a hosting decision layered on top of this schema, not a schema change.
