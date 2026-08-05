# AutoTranslator — Independent Review Report

**Reviewer:** Independent review agent (no prior involvement in the build)
**Scope:** `bbillionaires/autotranslator` @ `claude/multilingual-messaging-mvp-j3dxp4` (9 phases, commit `bcad887`)
**Method:** Full read of `docs/implementation-plan.md`, line-by-line reading of `src/server/**`, `src/app/**`, `prisma/schema.prisma` + migrations, `docs/*.md`, `.env.example`, `README.md`, `android-gateway/README.md`; ran the actual test suite (395/395 passing), `tsc --noEmit` (clean), and a live zero-credential env-boot check against a running local Postgres. No source files were modified.

---

## Executive summary

This is a well-engineered MVP that matches the implementation plan's architecture closely: the layering (Server Actions/Route Handlers → services → org-scoped repositories → Prisma), the idempotency-key dedup pattern, the "never mark SENT until the adapter confirms" discipline, and the webhook signature-validation code are all implemented carefully and mostly correctly, with thoughtful doc comments explaining the reasoning. The team's own self-flagged risk areas (constant-time comparisons, raw-body HMAC, Android token revocation logic) all check out under close inspection.

However, the review surfaced **one Critical, structural org-isolation bug** that directly contradicts the plan's own core claim ("true multi-tenant SaaS... every service-layer query is org-scoped") and would cause real cross-tenant data leakage the first time a second organization connects Telegram. It also surfaced a cluster of **features that are built as library code but never actually wired into the running application** (the automatic retry worker, device revocation, user management), which is a different and easy-to-miss failure mode from "not built" — the code exists, tests exist for the pure logic, but nothing in the deployed app ever calls it. Security-hardening items explicitly required by §6 (headers, rate limiting on the highest-risk endpoints) are also incomplete despite being called out as in-scope for this phase.

**Overall risk assessment: not ready for the Tester phase as-is.** The Critical finding must be fixed (or at minimum hard-blocked with a runtime guard) before any multi-org testing, and the High-severity gaps should be closed or explicitly re-scoped out of MVP by a human, not left implicit, before sign-off.

---

## Findings

### Critical

**C1. Telegram inbound-webhook routing is NOT organization-scoped — real cross-tenant data leakage in a multi-org deployment**
- **Where:** `src/server/repositories/channelAccountRepository.ts:49-54` (`findFirstActiveByChannelType`), called from `src/app/api/channels/telegram/webhook/route.ts:50-52` (`resolveTelegramChannelAccount`).
- **What's wrong:** Every inbound Telegram webhook resolves its `ChannelAccount` (and therefore its `organizationId`) via "the first ACTIVE `ChannelAccount` of type TELEGRAM, ordered by `createdAt`" — across **the entire deployment**, not scoped to any organization. Nothing prevents a second organization from creating its own TELEGRAM `ChannelAccount` (`registerTelegramWebhook` in `src/server/actions/telegram.ts` only checks *that org's own* existing accounts, `channelAccountRepository.listByChannelType(organizationId, "TELEGRAM")`).
- **Concrete failure scenario:** Org A enables Telegram and clicks "Register webhook now" → creates `ChannelAccount(orgId=A, TELEGRAM, ACTIVE)`. Later, Org B (a second tenant on the same deployment/shared `TELEGRAM_BOT_TOKEN`) also enables Telegram and clicks the same button → creates a second `ChannelAccount(orgId=B, TELEGRAM, ACTIVE)`. From that point on, **every** inbound Telegram message (there is only one bot/one webhook URL, since the bot token is one global env var) resolves to Org A's `ChannelAccount` (created first), so Org B's Telegram contacts, conversations, and messages are silently created and visible under Org A's organization. Org A's agents can read and reply to conversations that were never theirs; Org B never sees any of "its" Telegram traffic. This is precisely the "does the codebase properly prevent cross-org data leakage if a second org existed" scenario the review was asked to test, and the answer is **no**.
- **Note:** This is self-documented in `docs/channel-adapters.md` under "Known limitations" as a "post-MVP gap," and is consistent with the single-global-bot-token design. Documentation does not reduce the actual impact — the plan's own §10 states "There is no ... shared-across-orgs data path anywhere in the design," which this contradicts in practice the moment a second org is onboarded.
- **Suggested fix direction:** Either (a) hard-block a second org from ever creating an ACTIVE Telegram `ChannelAccount` while `TELEGRAM_ENABLED` implies a single global bot (enforce single-tenant-per-deployment for this channel at the DB/service layer, with a clear error), or (b) implement genuine per-org bot tokens with per-org webhook paths (e.g. `/api/channels/telegram/webhook/[channelAccountId]`) as the plan's own limitations note suggests, or (c) resolve via `getMe`/`externalAccountId` matching instead of "first ACTIVE row." Do not ship multi-org Telegram support without one of these.

---

### High

**H1. No security headers are implemented anywhere (§6.8 requirement)**
- **Where:** No `middleware.ts` exists in the repo; `next.config.ts` has no `headers()` function.
- **Why it matters:** The plan explicitly requires HSTS, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, a scoped CSP, and `Referrer-Policy` "set via Next.js middleware." None of this exists. The app currently ships with Next.js defaults only — no clickjacking protection, no MIME-sniffing protection, no CSP. This is a product/plan requirement, not a nice-to-have, and was explicitly called out as in-scope.
- **Fix direction:** Add `src/middleware.ts` (or `next.config.ts#headers()`) setting the headers listed in §6.8, scoped appropriately for the webhook routes (which may need different CSP/framing rules than the app UI).

**H2. Rate limiting only covers Android gateway routes — Telegram/WhatsApp webhooks and auth endpoints are unprotected (§6.4 requirement)**
- **Where:** `src/server/rateLimit.ts`'s own doc comment states it was "built now specifically to satisfy that requirement for the six Android gateway routes." Confirmed by grep: `gatewayDeviceRateLimiter`/`gatewayRegisterRateLimiter` are imported only in `src/app/api/gateways/**/route.ts`. Neither `src/app/api/channels/telegram/webhook/route.ts` nor `src/app/api/channels/whatsapp/webhook/route.ts` nor the Auth.js `[...nextauth]` route import any rate limiter.
- **Why it matters:** §6.4 explicitly lists "all public/webhook-adjacent endpoints (`/api/channels/*/webhook`, `/api/gateways/*`)" **and** "the auth sign-in/magic-link-request endpoints (to blunt credential stuffing / email-bombing)" as requiring rate limiting. Right now, an attacker can flood the Telegram/WhatsApp webhook endpoints (each of which does DB writes and, on the WhatsApp/Telegram translate path, calls the OpenAI API) or brute-force the Credentials sign-in endpoint with no throttling at all.
- **Fix direction:** Reuse the existing `RateLimiter`/`checkRateLimit` (already generic and Redis-upgradable per its own design) on the Telegram/WhatsApp webhook routes (keyed by IP or channel account) and on the Credentials `authorize()` callback / magic-link request (keyed by IP + email).

**H3. No user-management surface exists at all (§5 requirement, core RBAC feature)**
- **Where:** Searched for `listUsers`, `inviteUser`, `updateUserRole`, `deactivateUser` across `src/` — zero matches. `src/app/(app)/settings/page.tsx` has no Users section.
- **Why it matters:** The plan's API inventory (§5) explicitly lists this row: "Admin | Server Action `listUsers`/`inviteUser`/`updateUserRole`/`deactivateUser` | User management | Session+Role(Administrator+) | role changes audit-logged; cannot self-demote last Owner." RBAC (Owner/Administrator/Manager/Agent/Viewer) is a headline product requirement, but there is currently **no way for anyone to invite a user, change a role, or deactivate a user** through the running application — the only way roles are ever assigned is `prisma/seed.ts` or direct DB access. This is a significant functional gap in a stated core feature, not a peripheral one.
- **Fix direction:** Build the missing Server Actions + a Settings → Users section, including the "cannot self-demote the last Owner" guard the plan calls for.

**H4. The automatic retry/backoff worker is never invoked by the running application**
- **Where:** `src/server/messaging/retryQueue.ts`'s `runRetryWorkerOnce` — its own doc comment admits "a literal always-on cron/background process does not need to be running in this sandbox." Grepped for callers outside tests: none. No `instrumentation.ts`, no cron entrypoint, no route that triggers it.
- **Why it matters:** Retry/backoff on transient failures is an explicit core requirement (plan §3.6 step 8, Phase 5 DoD: "a simulated adapter failure is retried per the backoff policy and eventually reaches DEAD_LETTER"). The pure decision logic (`nextRetryDecision`, `computeBackoffDelayMs`) is correct and well-tested, and `handleSendFailure` correctly records `retry_scheduled` `MessageEvent`s — but nothing in the deployed app ever polls for due retries and calls `retryMessage`. In production, a transient failure (a Telegram 5xx, a network blip) will sit as `FAILED` forever unless a human notices and clicks "Retry" — the "automatic" part of "retry and backoff" does not exist at runtime.
- **Fix direction:** Wire `runRetryWorkerOnce` into something that actually runs — a Next.js `instrumentation.ts` background interval, a cron-triggered Route Handler (e.g. `/api/internal/retry-worker` hit by an external scheduler), or equivalent. This is a one-file gap given how cleanly the logic is already separated.

**H5. Confirmed real race condition in `resolveOrCreateContactAndConversation` (the Builder-flagged risk) — unhandled error path, not just a benign duplicate**
- **Where:** `src/server/messaging/contactResolution.ts:26-73`.
- **What's wrong:** Inside one `prisma.$transaction`, the function does `findByChannelAndExternalId` → if not found, `contactRepository.create` + `contactChannelIdentityRepository.create`. Under concurrent first-contact delivery (e.g., a brand-new Telegram/SMS/WhatsApp contact whose first two messages arrive almost simultaneously, or an aggressive webhook retry racing the original delivery), two transactions can both miss the existing-identity check and both attempt to insert. `ContactChannelIdentity` has `@@unique([channelAccountId, externalContactId])`, so the loser's insert throws a Prisma P2002 — and **this specific error is not caught anywhere** in `resolveOrCreateContactAndConversation` or in its only caller path before the message-level idempotency try/catch in `inboundService.processInboundMessage` (that catch only wraps the later Message-insert transaction, not this one).
- **Concrete failure scenario:** Two inbound webhook deliveries for the same brand-new external contact ID arrive close together (real for Telegram/Meta retry behavior, and plausible for a contact who sends two texts back-to-back before the first is fully processed) → one request 500s with an unhandled Prisma error instead of gracefully resolving to the now-existing contact. The sender's webhook layer will likely retry (self-healing for Telegram/WhatsApp, which retry aggressively on 5xx), but this still produces spurious `500`s, wasted work, and noisy error logs, and for Android's `/api/gateways/inbound` (no automatic retry from the device is guaranteed) a lost inbound SMS is possible if the device doesn't resend.
- **Fix direction:** Catch the P2002 on the identity/contact insert the same way `inboundService`/`outboundService` already do for the Message insert: on conflict, re-fetch the now-existing identity/contact instead of raising. This is a small, surgical fix given the existing idempotency pattern is already right next door.

**H6. Android device revocation is unreachable — no Server Action, no Route Handler, no UI**
- **Where:** `channelAccountRepository.revokeDevice` (`src/server/repositories/channelAccountRepository.ts:162-178`) is fully correct and enforced immediately by `androidAuth.authenticateDevice` (verified: checks `revokedAt` on every request). But it is called **only from tests** — no Server Action wraps it, no gateway route exposes it, and `src/app/(app)/settings/channel-integrations.tsx`'s own doc comment confirms: "no revoke button either."
- **Why it matters:** §6.3/§6.8 explicitly promise "an admin can revoke a device from Settings, invalidating the token immediately." Right now that is not true — an admin cannot revoke a compromised/lost device through the product at all; the only path is direct DB/script access. If a device is lost or an employee with device access leaves, there is no operational way to cut it off.
- **Fix direction:** Add a `revokeAndroidDevice` Server Action (Administrator+, audit-logged) and a button in Settings. The underlying mechanism is already correct — this is purely a missing entry point.

---

### Medium

**M1. AuditLog coverage gaps beyond the self-flagged `setContactLanguage`**
- Confirmed `setContactLanguage` (`src/server/actions/contacts.ts`) is genuinely un-audited (self-flagged in its own doc comment — confirmed correct).
- Also missing, contradicting §6.8's explicit list of what must be audited:
  - **`retryConversationMessage`** (`src/server/actions/messages.ts:101-113`) — plan §5 explicitly says "only allowed on terminal-failed states; **audit-logged**" for `retryMessage`; no `auditLogRepository.record` call exists in this action.
  - **Channel-account connect**: `registerTelegramWebhook` (`src/server/actions/telegram.ts:97-139`) creates a `ChannelAccount` with no audit log, despite §6.8 listing "channel account connect/disconnect/credential rotation" as audited.
  - **Android device registration**: `POST /api/gateways/register` (`src/app/api/gateways/register/route.ts`) issues a credential (device token) with no audit log either.
- **Fix direction:** Add `auditLogRepository.record(...)` calls to all three, consistent with the pattern already used correctly elsewhere (`archiveContact`, `assignConversation`, glossary CRUD, team actions, org settings).

**M2. The general "translation quality disclosure" banner from §6.9 was never built — only the opt-in high-risk variant exists**
- **Where:** `src/app/(app)/inbox/[conversationId]/high-risk-banner.tsx` — only rendered when `conversation.highRisk === true` (`page.tsx:73`, `composer.tsx:158`). Grepped for any general/dismissible disclosure banner: none found.
- **Why it matters:** §6.9 describes **two** distinct UI elements: (1) "A persistent, dismissible-but-re-shown banner... states that machine translation is imperfect" (implied to be broadly visible, not conditional), and (2) "an explicit opt-in 'high-risk conversation' flag" that adds a *stronger* warning on top. Only (2) was implemented. Right now, a normal (non-flagged) conversation carries **no** translation-quality disclosure at all, which is a real UX/liability gap for a product whose translations are LLM-generated and admittedly non-deterministic.
- **Fix direction:** Add a lightweight, dismissible (localStorage-remembered, re-shown periodically or per-session) general disclosure banner somewhere in the app shell (e.g. `src/app/(app)/layout.tsx`) independent of the per-conversation high-risk flag.

**M3. Auth lookup by bare email is not org-scoped, but the schema explicitly allows the same email in multiple orgs**
- **Where:** `src/server/auth.ts:89` (`prisma.user.findFirst({ where: { email } })` in the Credentials `authorize()`), and the Prisma adapter override `getUserByEmail` (`userRepository.findByEmail`).
- **Why it matters:** The schema's own constraint is `@@unique([organizationId, email])` — i.e., by design, the same real email address can belong to different `User` rows in two different organizations. But sign-in only takes email+password with no org selector, and `findFirst` returns an arbitrary match when more than one exists. In practice this means: if the same email is (legitimately, per the schema's own design) registered in two orgs, login behavior for that email is non-deterministic/order-dependent, and a user could be authenticated against the "wrong" org's account. This is a real inconsistency between the schema's stated design and the auth implementation, not a hypothetical.
- **Fix direction:** Either drop the per-org email uniqueness assumption from the login flow's mental model (document that emails must be globally unique in practice, and consider making the DB constraint reflect that), or make sign-in org-aware (e.g., an org-selection step, or a global-unique-email invariant enforced at invite time).

**M4. `connectChannelIdentity` Server Action (plan §5) was never implemented**
- **Where:** Grepped for `connectChannelIdentity` across `src/`: zero matches.
- **Why it matters:** The plan lists this explicitly: "Server Action `connectChannelIdentity` | Link a `ContactChannelIdentity` to a contact (merge duplicate identities) | Session+Role(Manager+)." Without it, there is no supported way for an agent/manager to merge two `Contact` records that turn out to be the same human across different first-contact events (e.g., a contact who first messaged as a "new" identity that should have matched an existing one, especially relevant given the identity-resolution race in H5).
- **Fix direction:** Implement it — the underlying repository primitives (`contactChannelIdentityRepository`) already support most of what's needed.

**M5. Android SMS gateway has no Settings UI at all (self-documented gap)**
- **Where:** `src/app/(app)/settings/channel-integrations.tsx` shows only a static "Not yet configured" placeholder card for `ANDROID_SMS`, despite the server-side gateway being fully functional.
- **Why it matters:** Phase 7's own Definition of Done states "every screen listed in the product brief exists and is navigable by an appropriately-role-authorized user." There is no way to register, view health, or (per H6) revoke an Android device from the UI — only via direct API calls. This compounds H6 (revocation is unreachable) and is a real UX dead end for what the plan calls a "fully-functional" channel.
- **Fix direction:** Build the missing Settings section (device list, register form, heartbeat/health display, revoke button).

---

### Low

**L1. README.md is stale**
- `README.md`'s own text says "This README currently reflects Phase 3 ('Foundation')" despite the branch being 9 phases in with Telegram, Android, WhatsApp, and the full inbox UI shipped. Low risk (doesn't affect runtime behavior) but will actively mislead a new contributor or the Tester agent about what's implemented.

**L2. `ChannelAccount.credentialRef` is effectively unused for the two real adapters**
- Both `TelegramAdapter` and `WhatsAppAdapter` read credentials directly from `env.*` (global env vars), never from `ChannelAccount.credentialRef`. This is consistent with the documented §6.6 stance (real per-org secret storage is an explicit, flagged, out-of-scope-for-MVP item) and is not a security bug — flagging only so the Tester doesn't spend time hunting for a credential-encryption path that was never meant to exist yet.

**L3. Minor UX: no visible indicator for *why* a conversation has no unread badge accuracy**
- `conversationRepository.listForInbox`'s "unread" heuristic (messages since the last outbound reply) is a reasonable documented approximation, but nothing in the inbox UI communicates that it's a heuristic — low priority, cosmetic.

---

## Verified solid — no need to re-check these

- **Constant-time webhook/token comparisons**: Telegram secret-token compare, WhatsApp `X-Hub-Signature-256` compare, and Android device-token-hash compare all correctly use `node:crypto`'s `timingSafeEqual` with a length-mismatch-safe fallback (self-compare, not early-return) in every location (`telegram/adapter.ts`, `whatsapp/adapter.ts`, `whatsapp/webhook/route.ts`, `gateways/androidAuth.ts`).
- **WhatsApp HMAC is computed over the genuinely raw body**: `WhatsAppAdapter.validateWebhook` uses `req.clone().text()` before any JSON parsing, and the route reads the body exactly once afterward via `req.text()` → `JSON.parse` — no re-serialization bug.
- **Android device-token design and revocation enforcement**: token is `deviceId.HMAC(deviceId)`, only the sha256 hash is ever persisted, and `authenticateDevice` correctly checks `revokedAt` on every single request — revocation *would* take effect immediately if it were reachable (see H6 for the missing entry point, which is a UI/wiring gap, not a logic gap).
- **Idempotency-key unique-constraint-catch pattern for Messages**: both `inboundService.processInboundMessage` and `outboundService.sendMessage` correctly attempt the insert first and catch P2002 (race-safe), rather than check-then-insert. This is the one place the "TOCTOU" pattern was done right; contrast with H5 where the same discipline wasn't applied to contact/identity creation.
- **"Never mark SENT before adapter confirmation"**: verified true for Telegram (synchronous API call, `SENT` only after 200+`message_id`), WhatsApp (synchronous Graph API call, `SENT` only after 200+`messages[].id`), and Android (correctly returns `QUEUED`, with the real `SENT` transition deferred to the device's own `/acknowledge` call). `assertValidTransition` correctly gates every status change through a state machine that disallows regressions.
- **Delivery-status callback idempotency and out-of-order handling** (`deliveryStatusService.ts`): correctly uses the same insert-then-catch-P2002 pattern, and correctly logs-but-doesn't-throw on an out-of-order/invalid transition rather than corrupting state or 500ing the webhook.
- **Prompt-injection resistance** (`translation/prompt.ts`): the untrusted message text is explicitly fenced (`<<<MESSAGE_START>>>...<<<MESSAGE_END>>>`) and the system prompt contains an explicit, well-written anti-injection instruction telling the model to treat the fenced content as opaque data, never as instructions. This is real, tested (`prompt.test.ts`), and correctly separated from the API-call code so it's unit-testable without a network call.
- **Zero-credential boot**: independently re-verified (not just re-reading the Builder's claim) by loading `src/server/env.ts` against a minimal env (`DATABASE_URL`/`DIRECT_URL`/`AUTH_SECRET`/`APP_URL` only, all `*_ENABLED` flags absent) — it loads cleanly and defaults `TRANSLATION_PROVIDER` to `"noop"` with no API key required.
- **Full test suite**: independently re-ran `npx vitest run` against a live local Postgres — **395/395 tests pass**, 51/51 files. `npx tsc --noEmit` is clean.
- **Encrypted credential storage design honesty**: confirmed `ChannelAccount.credentialRef` is never populated with a raw secret anywhere in the codebase (Telegram/WhatsApp both read straight from env at call time); `deviceTokenHash` is confirmed to only ever store a sha256 hash, never the raw device token (`issueDeviceToken`/`hashDeviceToken` in `androidAuth.ts`).
- **Org-scoped repository discipline overall**: spot-checked every repository file in `src/server/repositories/` — with the sole (self-documented, and now Critical-flagged for Telegram specifically) exceptions of the three intentional cross-org bootstrap lookups (`findFirstActiveByChannelType` for Telegram, `findById`/`findActiveByChannelTypeAndExternalAccountId` for Android/WhatsApp device-token and phone-number-id bootstrap), every other function takes and enforces `organizationId`. Existing integration tests (`conversations.test.ts`, `contacts.test.ts`) do correctly exercise cross-org isolation for Contact/Conversation actions.
- **RBAC spot-check**: `requireRole` is correctly called with the right minimum role at the top of every Server Action/Route Handler sampled (contacts, conversations, messages, teams, settings, glossary, telegram, whatsapp, gateway register) — confirmed by both reading the code and by the test suite's extensive negative-role-check assertions (visible in the test run's log output).
- **`composer.test.tsx` flakiness**: read in full alongside `composer.tsx`. No evidence of a genuine component-level race — `startTransition(async () => ...)` is an officially-supported React 19 pattern (this repo is on React 19.2.4/Next 16.2.12), and the test's use of `findByText`/`waitFor` around each async boundary is correct. Assessment: most likely genuine test-infrastructure flakiness (shared Vitest worker state, `fileParallelism` interactions already documented in `vitest.config.ts` for a different test file) rather than a real product bug — but recommend the Tester phase run this file in isolation a few times to be sure before fully dismissing it.

---

## Prioritized action list for the Builder (before Tester phase)

**Must fix (Critical):**
1. **C1** — Telegram cross-org channel-account resolution. This is the one finding that represents an actual, structural violation of the product's core multi-tenancy guarantee and must be fixed or explicitly hard-blocked (single-org-per-deployment guard) before any further testing that involves more than one organization.

**Should fix before Tester (High):**
2. **H3** — Build user management (invite/role-change/deactivate). Untestable RBAC lifecycle otherwise.
3. **H4** — Wire the retry worker into something that actually runs, or explicitly re-scope "automatic retry" out of this MVP's claims.
4. **H5** — Catch the P2002 in `resolveOrCreateContactAndConversation` the same way the Message-insert path already does.
5. **H1** — Add security headers middleware.
6. **H2** — Extend rate limiting to Telegram/WhatsApp webhooks and the auth endpoints.
7. **H6** — Wire up Android device revocation (Server Action + button).

**Fix opportunistically (Medium):** M1 (audit log gaps), M2 (general disclosure banner), M3 (auth email org-scoping), M4 (`connectChannelIdentity`), M5 (Android Settings UI).

**Low priority / defer:** L1–L3.

---

*Report generated by independent review; no source files were modified as part of this review.*

---

## Final Review (post-Tester, post-T1-fix)

**Reviewer:** Independent final-review agent (same lineage as the original review above; no prior involvement in the Builder's fix passes or the Tester phase).
**Scope:** `bbillionaires/autotranslator` @ `claude/multilingual-messaging-mvp-j3dxp4`, HEAD `96256be` (confirmed via `git pull` — already up to date). Covers the Builder's C1/H1–H6/M3/M5 fix pass, the Tester's T1 finding, and the Builder's 3-commit T1 fix (`39c24bb`, `a89201a`, `96256be`).
**Method:** Read every finding in `docs/implementation-plan.md`, this document's original findings, and `docs/test-report.md` in full. Independently re-read the actual current source for every fix (not commit messages). Ran the full verification suite myself against a live Postgres (`autotranslator` + `autotranslator_test`, both migrated, `autotranslator-postgres` container healthy). Wrote and ran two throwaway, out-of-repo verification tests (against the real test DB, real `FakeChannelAdapter`, deleted afterward — no files left in the tracked repo) to directly reproduce a suspected bug rather than reasoning about it from code alone. No application source files were modified as part of this review; this document is the only file touched.

### Verification suite results (independently re-run)

| Check | Result |
|---|---|
| `npm run lint` | 0 errors, 10 warnings (all the pre-existing benign `_unused`-parameter pattern in provider stubs/tests; no new lint debt) |
| `npm run typecheck` | Clean |
| `npm run build` | Succeeds (Next.js 16 production build; only a non-functional deprecation notice that `middleware.ts` should eventually be renamed `proxy.ts`) |
| `npm test -- --run` | **485/485 tests pass**, 62/62 files — matches the expected count exactly |
| `git log` / `git pull` | Already at `96256be` (HEAD of `claude/multilingual-messaging-mvp-j3dxp4`); nothing to pull |

### Verification table — every finding from the review + test report

| ID | Status | How verified |
|---|---|---|
| **C1** | VERIFIED FIXED | Read `resolveTelegramChannelAccount` (webhook route) and `registerTelegramWebhook` (`src/server/actions/telegram.ts`): a second org can no longer create an ACTIVE Telegram `ChannelAccount` while another org already has one (`findFirstActiveByChannelTypeInOtherOrg` guard, hard `ConflictError` before any Telegram API call), and the webhook route itself now fails loud (not silently-picks-one) if the invariant is ever violated by more than one active row. `telegram/webhook/route.test.ts`'s dedicated two-org test passes. |
| **H1** | VERIFIED FIXED | `src/middleware.ts` exists, sets HSTS/CSP/`X-Content-Type-Options`/`X-Frame-Options`/`Referrer-Policy` on a broad matcher; `src/middleware.test.ts` passes. Confirmed the CSP/headers are genuinely present, not just asserted in a mocked test. |
| **H2** | VERIFIED FIXED | `credentialsAuth.ts` imports/calls `authRateLimiter`; Telegram and WhatsApp webhook routes both import `webhookRateLimiter`/`rateLimitedResponse` (grep-confirmed). Rate-limit tests pass in the relevant route test files. |
| **H3** | VERIFIED FIXED | Read `src/server/actions/users.ts` in full: `listUsers`/`inviteUser`/`updateUserRole`/`deactivateUser` all exist, all `requireRole(..., "ADMINISTRATOR")`, all audit-log, `assertNotRemovingLastOwner` genuinely blocks removing the org's only Owner, `assertNotGrantingAboveOwnRank` blocks privilege escalation. `users.test.ts` exercises this against real Postgres. See also a related **new** finding below (session staleness) that this fix's existence newly exposes. |
| **H4** | VERIFIED FIXED | `src/app/api/internal/retry-worker/route.ts` exists, shared-secret gated, fails closed (`503`) if unconfigured, drives `runRetryWorkerOnce` across all orgs via `listAllFailedAwaitingRetryAcrossOrgs`. `retry-worker/route.test.ts` passes. |
| **H5** | VERIFIED FIXED | `resolveOrCreateContactAndConversation`'s Message-insert-style P2002 catch pattern was already correct per the Tester; re-read it, unchanged and correct in this review. |
| **H6** | VERIFIED FIXED | `revokeAndroidDevice` Server Action exists in `src/server/actions/android.ts` (Administrator+, audit-logged), wraps `channelAccountRepository.revokeDevice`; Settings UI has a working revoke button (`docs/channel-adapters.md`'s own changelog confirms, cross-checked against `android.test.ts`). |
| **M1** | PARTIALLY FIXED | `registerTelegramWebhook` (channel-account connect) and `POST /api/gateways/register` (Android device registration) now both write an `AuditLog` row — confirmed by reading both files. **However**, `retryConversationMessage` and the new `retryInboundMessageTranslation` (`src/server/actions/messages.ts`) still have **no** `auditLogRepository.record` call, despite the plan's own §5 spec explicitly saying `retryMessage` must be audit-logged. This was always "opportunistic," not mandatory — status is a partial fix, not a regression, and remains fine to defer. |
| **M2** | STILL OPEN AS DOCUMENTED-DEFERRED | Grepped the app shell (`src/app/(app)/layout.tsx`) and `composer.tsx`/`high-risk-banner.tsx`: only the opt-in per-conversation high-risk banner exists; no general, always-present translation-quality disclosure was added. Unchanged from the original finding — correctly still Medium, not escalated. |
| **M3** | VERIFIED FIXED | Confirmed via the Builder's `b92a051` fix pass (bundled with C1): re-read `auth.ts`/`userRepository.findByEmail` — it now throws instead of silently picking an arbitrary org when the same email exists in more than one org (log line "multiple accounts share this email across organizations" observed in the actual test run output). |
| **M4** | STILL OPEN AS DOCUMENTED-DEFERRED | `connectChannelIdentity` still has zero implementation matches anywhere in `src/`. The new `e2eAdminScenario.test.ts` explicitly stands in for it with a raw repository call and says so in its own comment. Unchanged, correctly still Medium. |
| **M5** | VERIFIED FIXED | Settings → channel integrations now has a real Android section (device list/register/heartbeat/revoke), per `3d82234`'s fix and cross-checked against the current `channel-integrations.tsx`. |
| **L1** | Not re-checked in depth | Out of scope for this pass (cosmetic, README staleness) — no reason to expect it self-resolved; low priority, unchanged. |
| **L2** | STILL OPEN AS DOCUMENTED-DEFERRED | Still accurate/consistent with the documented MVP stance; not a bug. |
| **L3** | STILL OPEN AS DOCUMENTED-DEFERRED | Still accurate; cosmetic, unchanged. |
| **T1** | VERIFIED FIXED | Read `inboundService.ts`, `outboundService.ts`, `failureClassifier.ts`, `failureTransition.ts`, `messageRepository.ts` in full. Both lifecycles now store the `Message` row (with `originalText`) *before* calling the translation engine, and a thrown translation call is caught and transitions the row to `FAILED` with a `failureReason` instead of losing it. Confirmed the two `it.fails` regression tests were genuinely converted to real passing assertions (`specialCasesAndFailures.test.ts`) — not skipped, not weakened — and independently re-ran them. Retry-after-recovery for both directions is covered and passes. **The "is inbound retry reachable" question is answered below.** |

### Is inbound translation retry actually reachable from the running app? (Task's specific concern)

**No gap — this is genuinely wired end-to-end, not another "H6-before-the-fix" situation.** Traced the full path:

1. `inboundService.retryInboundTranslation(organizationId, messageId)` — the service function — exists and is correct.
2. `retryInboundMessageTranslation` (`src/server/actions/messages.ts`) is a real, exported, `requireRole(..., "AGENT")`-guarded Server Action wrapping it — not just a service function sitting unused.
3. `src/app/(app)/inbox/[conversationId]/message-thread.tsx` imports **both** `retryConversationMessage` and `retryInboundMessageTranslation`, and its `handleRetry` correctly branches on `message.direction === "INBOUND"` to call the right one.
4. The "Retry" button itself renders whenever `canRetry && (status === "FAILED" || status === "DEAD_LETTER")` — `canRetry` is threaded down from the conversation page as `canSend` (`roleAtLeast(role, "AGENT")`), so any Agent-or-above viewing a conversation with a FAILED inbound (translation-failed) message sees and can click a real, working Retry button.

So: unlike H6 before its fix, there is no missing entry point here — the manual-retry design decision is fully surfaced in the UI, not stranded as unreachable backend logic. (A real, but much smaller, gap in this exact area is noted as **NEW-3** below: no *component-level* test exercises this specific inbound-click path.)

### New findings from the fresh pass (not in the review report or test report)

#### High

**NEW-1. `confirmAndSend` calls the real channel adapter *before* validating the message is actually in a sendable state — reachable, verified, defeats the T1 guarantee it sits right next to**

- **Where:** `src/server/messaging/outboundService.ts`, `confirmAndSend` (called directly by the Server Action `confirmAndSendConversationMessage`, and internally by `sendMessage`/`retryMessage`).
- **What's wrong:** `confirmAndSend` loads the `Message` row and immediately calls `deps.adapter.sendMessage({..., text: message.translatedText ?? message.originalText, ...})` — it never checks `message.status` or `message.direction` first. `assertValidTransition(message.status, sendResult.status)` only runs **after** the adapter call has already returned success, so by the time an invalid-transition error is thrown, the real external send has already happened and cannot be undone.
- **Concrete, independently-reproduced failure scenarios** (verified live, against the real `autotranslator_test` Postgres and the real `FakeChannelAdapter`, via a throwaway test written and deleted for this review — not just read from source):
  1. **Untranslated-text leak, directly related to the T1 fix's own new code path:** call `confirmAndSend`/`confirmAndSendConversationMessage` with the id of a message that failed at the *translation* step (`status: "FAILED"`, `translatedText: null` — a row that, before the T1 fix, never durably existed at all, and now does). The adapter is called with `text: message.originalText` — the **raw, untranslated** text — and genuinely "sends" it (confirmed: `adapter.sentMessages[0].text === "SECRET RAW ENGLISH TEXT"`, the literal untranslated input). Only afterward does `assertValidTransition("FAILED", "SENT")` throw `ConflictError`, but the send already went out; the DB update never happens (the message row is left `FAILED`), so there's no record the send even occurred. Every UI path (`composer.tsx`) happens to avoid constructing this call under normal conditions, but the Server Action itself validates nothing about the target message beyond "does this id belong to my org" — any AGENT+ session can invoke it with any message id in their org, and a network retry/replay of a client's own "Confirm & send" click is a completely ordinary way to hit this without any malicious intent.
  2. **Silent duplicate send:** calling `confirmAndSend` a second time on an already-`SENT` message re-invokes the adapter a second time (confirmed: `adapter.sentMessages.length === 2` after two calls) — `canTransition(from, to)` treats `from === to` as always valid, so `assertValidTransition("SENT", "SENT")` raises no error either; the call reports `outcome: "SENT"` as if nothing were wrong. An ordinary double-click before a button disables, or a network-level request retry, reaches this.
- **Why this belongs in this review specifically:** scenario 1 only became possible once the T1 fix started durably persisting translation-failed rows — before T1, there was nothing to `confirmAndSend` against in that state, so this exact failure mode is new surface area exposed by the very fix this final review was asked to scrutinize hardest.
- **Suggested fix direction (not implemented — review-only):** at the top of `confirmAndSend`, assert `message.direction === "OUTBOUND"`, `!message.isInternalNote`, and `message.status === "PENDING"` (mirroring the precondition discipline `retryMessage`/`retryInboundTranslation` already apply before doing anything externally visible), throwing `ConflictError` before ever touching `deps.adapter`.

#### High

**NEW-2. Deactivating a user or demoting their role does not revoke their already-issued session — the H3 feature's core promise ("cut off access") doesn't actually take effect until the JWT expires**

- **Where:** `src/server/auth.ts` — `session: { strategy: "jwt" }`, and the `jwt`/`session` callbacks only ever set `userId`/`organizationId`/`role` claims from the DB `user` object at the moment of initial sign-in (`if (user) { token.role = ... }`); on every subsequent request the callback returns the token unchanged, with no DB re-check. `requireRole` (`src/server/roles.ts`) only ever inspects the role claim already sitting in the session — never the database.
- **Why it matters:** `deactivateUser`/`updateUserRole` (the H3 fix) write to the `User` row, but a user who already has a live session (default NextAuth JWT `session.maxAge` is 30 days, and this app sets no override) keeps acting under their **old** role/active-status for the rest of that session's lifetime — deactivation and demotion are not enforced server-side per request the way `docs/implementation-plan.md` §6.2 promises ("enforced server-side per the requirement, not just hidden in the UI"). The plan itself anticipated this exact gap back in §2.2 ("a `Session` model is still kept in Prisma... primarily... for a future 'revoke all sessions' admin action") but that action was never built, and it isn't listed in §7's risk register or called out anywhere in `docs/channel-adapters.md`'s known-limitations sections either — it's a genuinely undocumented gap, not a flagged-and-accepted one.
- **Concrete failure scenario:** an Administrator deactivates a user they believe poses an immediate risk (departing employee, suspected compromised account) via the new Settings → Users "Deactivate" button. `verifyCredentials` correctly blocks that user's *next* sign-in attempt — but if they already have an open browser session/JWT (which is the exact scenario "deactivate this user right now" is meant to guard against), they can keep sending messages, reading conversations, and touching every AGENT+-gated action for up to 30 days, or until they happen to sign out.
- **Suggested fix direction (not implemented — review-only):** the cheapest fix is a short JWT `maxAge` (e.g. minutes, forcing frequent silent re-issuance) combined with re-fetching `deactivatedAt`/`role` from the DB inside the `jwt` callback on every refresh (Auth.js supports this — the callback already has DB access via `prisma`); a fuller fix moves to database sessions (the `Session` model already exists in the schema for exactly this) or adds an explicit token-versioning/"security stamp" column checked per request.

#### Low

**NEW-3. `MessageThread`'s component test never exercises the inbound-retry click path it added**

- **Where:** `src/app/(app)/inbox/[conversationId]/message-thread.test.tsx` mocks `@/server/actions/messages` with only `retryConversationMessage: vi.fn(...)` — `retryInboundMessageTranslation` (the export `message-thread.tsx` now also imports and calls for a FAILED inbound message) is absent from the mock.
- **Why it matters:** production wiring is correct (verified above), but no test at the component level ever renders a FAILED **inbound** message with `canRetry: true` and clicks "Retry" — if one did today, it would hit `undefined()` in this test file's mock and throw. This is a coverage gap the Tester's UI-adjacent testing didn't catch, not a production bug.
- **Suggested fix direction:** add `retryInboundMessageTranslation: vi.fn(...)` to the mock and a test case mirroring the existing "shows a retry button for a FAILED outbound message" one, but for `direction: "INBOUND"`.

#### Low

**NEW-4. The new internal retry-worker endpoint's secret comparison and rate-limiting don't match this codebase's own established discipline**

- **Where:** `src/app/api/internal/retry-worker/route.ts` — `if (!provided || provided !== env.INTERNAL_WORKER_SECRET)`.
- **Why it matters:** every other secret/signature comparison in this codebase (Telegram webhook secret, WhatsApp HMAC, Android device-token hash) deliberately uses `node:crypto`'s `timingSafeEqual` specifically to avoid timing side-channels (called out as "verified solid" in the original review) — this new H4-fix endpoint uses a plain `!==` instead, and, unlike the Telegram/WhatsApp webhook routes and the Android gateway routes, imports no rate limiter at all despite being a public HTTP route guarded only by a static shared secret.
- **Impact is modest** (the secret is a long random operator-configured value, not a low-entropy credential, and successful exploitation would only let an attacker trigger retry passes early, not read/write arbitrary data), which is why this is Low rather than High/Medium — but it is a real, avoidable inconsistency in a security-relevant new code path.
- **Suggested fix direction:** swap the comparison for the same `timingSafeEqual`-with-length-guard helper already used elsewhere, and add the existing generic rate limiter to this route.

### Overall final verdict

**The Critical and all six High findings from the original review are genuinely, solidly fixed** — independently re-verified by reading the current code (not commit messages) and by re-running the full test suite (485/485) plus a build and manual reproduction of the previously-Critical C1 scenario's guard. **T1 is also genuinely fixed**, including the specific "is the manual retry path actually reachable" concern this task asked to scrutinize — it is fully wired UI-to-database, not a repeat of the H6 pattern.

However, this fresh pass surfaced **two new High-severity issues** that a ship decision should weigh seriously:

- **NEW-1** is a live, reproduced bug (not a hypothetical) sitting directly adjacent to — and partially enabled by — the very T1 fix this review was asked to scrutinize hardest: it can cause a real customer to receive raw, untranslated text, or receive a duplicate message, through a code path (`confirmAndSendConversationMessage`) that's one ordinary double-click or network retry away from firing in normal use, no adversarial intent required.
- **NEW-2** means the brand-new H3 user-management feature's headline promise — "an Administrator can cut off a user's access" — does not actually take effect in real time for anyone with an already-open session, for up to 30 days. This is a meaningful gap for a feature whose entire purpose is access control.

Both are small, surgical, well-understood fixes (a precondition guard in one function; a JWT-refresh/DB-recheck or session-strategy change in another) — neither requires re-architecting anything else this review touched. Given that, **this build is close but not yet ready to ship as-is**: the Critical/High backlog from the original review is in genuinely good shape, but I would not sign off on "MVP-ready with documented limitations" while NEW-1 remains open, since it is a live functional defect (not a documented tradeoff) that can visibly misbehave in front of a real customer during completely ordinary use. NEW-2 is more of a security-hardening gap than an immediate functional break and could reasonably be documented as a known limitation (alongside M2/M4/L1–L3) if a human sign-off explicitly accepts that risk for this MVP — but it should be an explicit decision, not a silent one, given it directly undercuts a feature that was just built specifically to address it.

**Recommendation: fix NEW-1 before shipping (small, contained change); make an explicit, documented call on NEW-2 (fix now, or accept and document as a known MVP limitation) rather than leaving it implicit.** Everything else reviewed here is in solid, ship-ready shape.

*Final review generated independently; no application source files were modified — only this report was appended to.*
