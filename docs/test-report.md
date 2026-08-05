# AutoTranslator — Tester Phase Report

**Tester:** Independent QA agent (no prior involvement in build or review)
**Scope:** `bbillionaires/autotranslator` @ `claude/multilingual-messaging-mvp-j3dxp4`, commit `9e08cb8` (Builder's fix-pass for the Reviewer's C1/H1–H6 findings)
**Method:** Ran the full existing suite for a baseline, read every fix's source + its existing tests, added new tests only where a required scope item was genuinely uncovered (verified by reading, not assumed), re-ran everything, and independently re-exercised C1/H1–H6 against real Postgres and (for H1) a real running HTTP server — not just re-reading the Builder's code.

---

## Summary

| | Before (baseline) | After (this phase) |
|---|---|---|
| Test files | 58 | **62** |
| Tests | 441 | **483** |
| `npm run lint` | 0 errors, 7 warnings | 0 errors, 9 warnings (2 new, same benign `_unused` pattern as existing code) |
| `npm run typecheck` | clean | clean |
| `npm run build` | succeeds | succeeds |

All 483 tests pass, including two intentionally-`it.fails` tests that document a real, newly-found bug (see Findings). No application/production source was modified.

**Test infra limitations:** No browser/Playwright is available in this sandbox (consistent with prior phases' own notes in `docs/implementation-plan.md` §9 and `docs/review-report.md`). Substitute: every new "end-to-end" test drives the **real** Server Actions and the **real** Telegram webhook Route Handler against a **real** Postgres test database (`autotranslator_test`), using the `FakeChannelAdapter`/`NoopTranslationProvider` pattern already established in Phase 5 — "signs in" is a mocked Auth.js session, matching every existing action test in this codebase (no test anywhere here drives Credentials sign-in through an actual browser either). This is a materially stronger substitute than a mocked-Prisma unit test: real unique constraints, real transactions, real cascades.

## Coverage by required scope area

**Unit** (language-priority, translation service, glossary, channel normalization, state transitions, retry rules, permissions, idempotency) — already fully covered: `resolveLanguage.test.ts`, `engine.test.ts`, `openai.test.ts`/`noop.test.ts`, `glossaryRepository.test.ts`, `telegram/parse.test.ts`/`androidSms/parse.test.ts`/`whatsapp/parse.test.ts`, `retryQueue.test.ts`/`failureClassifier.test.ts`, `roles.ts` spot-checks throughout action tests, `idempotency.test.ts`. No gaps found; nothing added.

**Integration** (DB ops, contact/conversation creation, all 6 message-delivery directions, WhatsApp verification, failed translation/send, duplicate webhook) — mostly covered already (`inboundService.test.ts`, `outboundService.test.ts`, `contactResolution.test.ts`, per-channel route tests). **Added:** the translation-failure gap (see Findings) had zero coverage — now in `src/server/translation/__tests__/specialCasesAndFailures.test.ts`.

**Successful/failed deliveries, both directions, all 3 real channels** — already covered (`telegram/webhook/route.test.ts`, `gatewayE2e.test.ts`, `whatsapp/webhook/route.test.ts`, `deliveryStatusService.test.ts`). No gaps.

**Duplicate webhooks (Telegram/Android/WhatsApp)** — already genuinely covered by hitting real route handlers twice with identical payloads in all three route test files; confirmed exactly one `Message` row each time. No gaps.

**Unsupported languages** — new: `specialCasesAndFailures.test.ts` feeds a bogus target-language code (`"xx-TOTALLY-BOGUS-CODE"`) through the real outbound pipeline; confirms it's stored and sent, not rejected/crashed.

**Translation API failures** — **new, and this is where a real bug was found** (see Findings). `specialCasesAndFailures.test.ts`'s two `it.fails` cases prove neither `processInboundMessage` nor `sendMessage` degrades gracefully on a thrown/timed-out translation call.

**Malformed requests (all public routes + Server Actions)** — already thoroughly covered per-route (`400`-class responses verified for all 6 Android gateway routes, Telegram, WhatsApp) and per-action (Zod-rejection tests throughout `src/server/actions/*.test.ts`). No gaps.

**Unauthorized access (role/device/webhook-signature)** — already thoroughly covered per surface. **Added:** an explicit cross-org-plus-insufficient-role assertion inside the new end-to-end scenario test, and the dedicated cross-org suite below.

**Contact-language changes mid-conversation** — **gap found and filled.** New file: `src/server/messaging/__tests__/languageChangeMidConversation.test.ts` (3 tests) — proves a later outbound message uses the newly-set contact language / conversation override, a later inbound message uses a newly-assigned user's language, and in every case the **earlier** message's stored `targetLanguage`/`translatedText` is never retroactively mutated.

**Multiple organizations / strict data isolation** — the review's C1 (Telegram) fix is already re-verified end-to-end in the existing `telegram/webhook/route.test.ts` (a dedicated test creates two orgs with active Telegram accounts and asserts `409`, zero messages routed to either). Everything else — contacts, conversations, messages, glossaries, teams, channel accounts, Android devices, and all four new (H3) user-management actions — had thinner-than-claimed cross-org coverage (several action test files never exercised a foreign-org id at all). **New file:** `src/server/__tests__/crossOrgIsolation.test.ts` (15 tests) — adversarially attacks every one of those surfaces with a real, existing Org-A id from an Org-B session. **All 15 pass** — org-scoping discipline is genuinely solid everywhere sampled.

**Inbound/outbound translation round trip** — already covered by Phase 5's `inboundService.test.ts`/`outboundService.test.ts`/`gatewayE2e.test.ts`. **Added:** a full administrator-scenario walk (see below) as the primary "real scenario end-to-end" artifact.

**Special translation test cases** — prompt-injection resistance was genuinely well covered already (`prompt.test.ts`, `openai.test.ts`) — real, not superficial. **Added** (`specialCasesAndFailures.test.ts`, 23 tests): names, phone numbers, URLs, emails, addresses, currency, dates/times, legal terminology, medical terminology, slang, emojis, mixed-language text, whitespace-only text, a ~15,000-char message, Arabic and Hebrew RTL script, a ZWJ-emoji-family + combining-diacritics Unicode edge case, a bidi-override control character, and two additional prompt-injection variants driven through the **real** stored-message pipeline (not just prompt-string assertions) — every case survives the real inbound pipeline with `originalText` preserved verbatim and no crash.

**End-to-end administrator scenario** — new file `src/app/__tests__/e2eAdminScenario.test.ts`: create contact → assign Spanish → real Telegram webhook POST delivers a Spanish message → inbox message correctly resolves `sourceLanguage="es"` → admin replies in English, resolves `targetLanguage="es"`, and the exact text handed to the `FakeChannelAdapter` is asserted → reveal-original (`originalText`/`translatedText` both present on one row) → conversation language override changed to French, verified on the *next* message while the *prior* message keeps `es` → a transient send failure is retried successfully via `retryConversationMessage` → a wrong-org session and an insufficient-role session are both rejected with zero data written. All in one test, all against real Postgres + real route handler + real Server Actions.

## New bugs found (not in `docs/review-report.md`)

**T1 (High) — Translation-provider failures are not caught anywhere in the message pipeline; the message is not stored at all, not just "degraded."**
- **Where:** `src/server/messaging/inboundService.ts` (`processInboundMessage`, the `engine.detectLanguage()`/`engine.translate()` calls around lines 75–102) and `src/server/messaging/outboundService.ts` (`sendMessage`, the `engine.translate()` call at line 91) — neither has a try/catch around the translation call, unlike the adapter-send path (`confirmAndSend`'s catch → `handleSendFailure`, which correctly stores a `FAILED` message with `failureReason`).
- **Repro:** construct a `TranslationProvider` whose `translate()`/`detectLanguage()` throws (simulating an OpenAI timeout/5xx), inject it via `{ engine }` into either `processInboundMessage` or `sendMessage`, and observe the call reject with an unhandled `Error` — **zero** `Message` row is ever created. See `src/server/translation/__tests__/specialCasesAndFailures.test.ts`'s two `it.fails` cases for exact, runnable repro steps.
- **Impact:** For a route handler this surfaces as a `502`/`500` (safely, via `handleRouteError` — no client-facing crash), and Telegram/WhatsApp's own webhook-retry behavior provides some self-healing. But: (a) the original message text is preserved **nowhere** durable — not as a draft, not as a `FAILED` row — so it cannot be manually retried the way an adapter-send failure can; (b) for the Android gateway's `/inbound` endpoint there is no guaranteed sender-side retry, so a real inbound SMS can be permanently lost during a translation-provider outage; (c) for an agent composing an outbound reply, the compose action simply errors with no persisted draft, so the typed text must be retyped. This directly contradicts the product brief's explicit requirement that translation failures "not silently lose" the message and leave "a clear failure state."
- **Suggested fix direction (not implemented here, per working rules):** store the `Message` row (or at least log a durable `MessageEvent`) with `originalText` and a `FAILED`-shaped status *before* attempting translation, or wrap the translation call in the same catch/backoff machinery `handleSendFailure` already uses for adapter failures.

No other new Critical/High/Medium/Low findings surfaced. Everything else exercised (cross-org isolation across 15 adversarial cases, all 6 Android gateway routes, WhatsApp signature/duplicate handling, contact-language-change semantics, unsupported-language handling, 23 special-content categories) behaved correctly on first attempt.

## Re-verification of the review's Critical/High findings — genuinely exercised, not re-read

- **C1 (Telegram cross-org leakage) — CONFIRMED FIXED.** `telegram/webhook/route.test.ts`'s dedicated C1 test creates two real orgs each with an ACTIVE Telegram `ChannelAccount` and asserts the webhook returns `409` with zero messages routed to either org; `registerTelegramWebhook`'s guard is likewise real (reads `docs/review-report.md`'s exact fix). Re-ran this test directly against real Postgres.
- **H1 (security headers) — CONFIRMED FIXED, verified over real HTTP, not just the unit test.** Built and started the actual production server (`npm run build && npm start`) and `curl`'d both `/sign-in` (200) and `/api/channels/telegram/webhook` (404, Telegram disabled in this run's env) — both real HTTP responses carry `Content-Security-Policy`, `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, and `Referrer-Policy`.
- **H2 (rate limiting on Telegram/WhatsApp webhooks + auth) — CONFIRMED FIXED.** Existing route tests genuinely flood the real route handler past `WEBHOOK_RATE_LIMIT.limit` and observe `429`; `credentialsAuth.ts` imports and calls `authRateLimiter`. Confirmed by reading the wiring (`grep` shows all of Telegram, WhatsApp, all 6 gateway routes, and `credentialsAuth.ts` import a limiter) and by the passing rate-limit test in `telegram/webhook/route.test.ts`.
- **H3 (user management) — CONFIRMED FIXED and working**, including the last-Owner guard and privilege-escalation guard: `users.test.ts`'s existing tests genuinely invite/promote/demote/deactivate real users against real Postgres, and my new `crossOrgIsolation.test.ts` additionally proves an Org-B Owner cannot touch Org-A's Owner via `updateUserRole`/`deactivateUser`.
- **H4 (retry worker route) — CONFIRMED FIXED and working.** `retry-worker/route.test.ts` hits the real route with the correct/missing/wrong `X-Internal-Worker-Secret` header and confirms it actually retries due `FAILED` messages across orgs.
- **H5 (contact-resolution race) — CONFIRMED FIXED.** `contactResolution.test.ts`'s H5 test fires two genuinely concurrent `Promise.all` calls against real Postgres for the same brand-new external contact id and confirms exactly one `Contact`/`ContactChannelIdentity` results, with no unhandled P2002.
- **H6 (Android device revocation) — CONFIRMED FIXED and working end-to-end.** `android.test.ts`'s H6 test and the broader `gatewayE2e.test.ts` both register a real device, revoke it via the real Server Action, and confirm a subsequent real gateway request (heartbeat/pending/inbound) is rejected with `401` using the *same* still-presented token.

## Files added

- `src/server/__tests__/crossOrgIsolation.test.ts` — 15 tests
- `src/server/messaging/__tests__/languageChangeMidConversation.test.ts` — 3 tests
- `src/server/translation/__tests__/specialCasesAndFailures.test.ts` — 23 tests (21 passing normally, 2 `it.fails` documenting bug T1)
- `src/app/__tests__/e2eAdminScenario.test.ts` — 1 test (full multi-step scenario)

No application/production source files were modified.
