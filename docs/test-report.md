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

---

## Final Verification (independent close-out Tester, post-NEW-1/NEW-2 fix)

**Tester:** Independent final-verification agent (no prior involvement in the build, review, or earlier Tester pass).
**Scope:** `bbillionaires/autotranslator` @ `claude/multilingual-messaging-mvp-j3dxp4`, HEAD `d50eabc` (confirmed via `git pull` — already up to date). Covers the Builder's fixes for C1/H1–H6/M3/M5/T1/NEW-1/NEW-2 across all commits through `d50eabc`.
**Method:** Ran the full required suite fresh against a live `autotranslator-postgres` container (dev + `autotranslator_test` DBs, both migrated). Independently wrote and ran throwaway verification tests (against the real test DB and real `FakeChannelAdapter`, deleted afterward — no files left in the tracked repo, `git status` clean throughout and at the end) rather than re-reading the Builder's own claims. Did one additional fresh adversarial pass targeted specifically at this round's new code.

### Final suite results (fresh run)

| Check | Result |
|---|---|
| `npm run lint` | 0 errors, 12 warnings (all pre-existing benign `_unused`-parameter pattern; no new lint debt) |
| `npm run typecheck` | Clean |
| `npm run build` | Succeeds (Next.js 16 production build; same non-functional `middleware`→`proxy` rename notice as before, unrelated to this round) |
| `npm test -- --run` | **492/492 tests pass**, 63/63 files — matches the expected count exactly, re-run twice for stability |
| `git pull` / HEAD | Already at `d50eabc`; nothing to pull |

**Zero regressions**: re-ran the full suite twice (identical 492/492 both times) and separately isolate-ran the four Tester-phase files (`crossOrgIsolation.test.ts` 15, `languageChangeMidConversation.test.ts` 3, `specialCasesAndFailures.test.ts` 25 — the two former `it.fails` T1-regression cases are now real passing assertions per the T1 fix, `e2eAdminScenario.test.ts` 1 — 44 tests total, all green in isolation) with no interaction effects from this round's `auth.ts`/`outboundService.ts` changes.

### NEW-1 re-verification — genuinely re-exercised, not re-read

Wrote and ran a throwaway test (`__verify_NEW1.test.ts`, deleted after use) independent of the Builder's own `outboundService.test.ts` assertions, using a call-order spy on `FakeChannelAdapter.sendMessage` (not just a post-hoc `sentMessages.length` check) plus a fresh `prisma.message.findUnique` re-read of the row, against real Postgres:

- A message that failed at the **translation** step (`status: FAILED`, `translatedText: null`) fed into `confirmAndSend`: the spy recorded **zero** adapter invocations before or during the thrown `ConflictError`, and the re-fetched DB row still shows `status: FAILED`, `translatedText: null` — the raw `originalText` genuinely never reached the adapter.
- A second `confirmAndSend` call on an already-`SENT` message: rejected with `ConflictError`, adapter call count stayed at `1` (no second real send).

**NEW-1's documented fix holds for the exact two scenarios it was written to fix.** However, this pass also found a **related, undocumented gap in the same function** — see "New findings" below.

### NEW-2 re-verification — genuinely re-exercised, not re-read

`src/server/authTokenRefresh.test.ts`'s 5 tests already drive the real production path end to end (not a mocked shortcut): they call the actual `deactivateUser`/`updateUserRole` Server Actions against real Postgres, then feed a token captured *before* that change into the real `refreshSessionTokenClaims` and assert the outcome. Independently re-ran this file in isolation and it passed cleanly, with the expected log lines observed (`"Session token refresh: user is deactivated; invalidating."`, `"Session token refresh: token has no userId claim; invalidating."`, `"Session token refresh: user no longer exists; invalidating."`).

Additionally verified independently, not just by re-reading:
- Attempted to import `src/server/auth.ts` directly in a throwaway Vitest test to see if the actual `NextAuth(...)` `jwt`/`session` callbacks could be exercised end-to-end. Confirmed the codebase's own claim: this fails under Vitest's "node" environment (`Cannot find module '.../node_modules/next/server' imported from next-auth/lib/env.js`) — this is *why* `refreshSessionTokenClaims` was deliberately extracted into its own directly-testable module, and confirms that testing it in isolation (as the existing suite does) is the correct and necessary approach here, not a shortcut.
- Read `auth.ts`'s actual exported config (not just the doc comment) and confirmed `session: { strategy: "jwt", maxAge: SESSION_MAX_AGE_SECONDS }` and `jwt: { maxAge: SESSION_MAX_AGE_SECONDS }` with `SESSION_MAX_AGE_SECONDS = 30 * 60` are genuinely wired in, and that the `jwt` callback's refresh branch (no fresh `user` object) calls `refreshSessionTokenClaims(token)` directly with no additional logic in between.
- Grepped the whole test suite for `maxAge`/session-mock patterns: no test anywhere asserts on the old 30-day default, and every action/route test that touches auth mocks the exported `auth()` function directly (bypassing the `jwt`/`session` callbacks entirely, the established pattern this codebase already used before this round) — confirmed this is *why* the `maxAge` change caused zero collateral test breakage, not an accidental gap in coverage.

**NEW-2's documented fix holds**: a deactivated user's next session refresh genuinely dies, a demoted user's next refresh genuinely picks up the lower role, and both are enforced within the documented ~30-minute (and typically much sooner, since the refresh branch runs on every request per Auth.js's own JWT-callback semantics) window.

### New findings from this pass — one real, undocumented race condition

#### High

**NEW-5. `confirmAndSend` and `retryMessage`'s NEW-1/precondition guards are not atomic with their state-changing write — truly concurrent calls on the same message can both pass the guard and both send, defeating the exact "no duplicate send" guarantee NEW-1 was fixed to provide**

- **Where:** `src/server/messaging/outboundService.ts` — `confirmAndSend` (reads `message.status` via `findByIdInOrgOrThrow`, checks it in memory, calls `deps.adapter.sendMessage`, and only afterward calls `messageRepository.updateStatus`) and `retryMessage` (same shape: `assertValidTransition` check, then `updateStatus`, then delegates to `confirmAndSend`/`retryTranslationThenSend`). Neither wraps the read-check-act sequence in a transaction, row lock, or a conditional/optimistic-locking write (`messageRepository.updateStatus` is a plain `updateMany({ where: { id, organizationId } })` with no status predicate in the `WHERE` clause).
- **What's wrong:** NEW-1's fix genuinely closes the *sequential* double-confirm case (call, await, call again — which the Builder's own regression tests exercise). It does **not** close the *concurrent* case: two overlapping in-flight calls on the same `PENDING` message both read `status: "PENDING"` before either one's `updateStatus` write lands, so both pass the guard, both call the real adapter, and both succeed — silently, with no error surfaced to either caller.
- **Independently reproduced** (throwaway tests, `__verify_concurrent_confirm.test.ts` and `__verify_concurrent_retry.test.ts`, both deleted after use, run against real Postgres and the real `FakeChannelAdapter`, no mocking of the guard or the DB layer):
  - `confirmAndSend` called via `Promise.all` twice on the same `PENDING` draft: **hit the race in 2 of 5 runs** (`adapter.sentMessages.length === 2`, both calls `fulfilled`, zero `rejected` — i.e. it reported success for both, not "second one failed").
  - `retryMessage` called via `Promise.all` twice on the same `FAILED` message (simulating the automatic cron retry worker overlapping with a human's manual "Retry" click — a realistic scenario now that H4's worker actually runs on a schedule): **hit the race in 1 of 5 runs** (adapter called twice, both fulfilled).
- **Concrete realistic trigger:** an ordinary double-click that fires two overlapping network requests before the UI disables the button (the exact "double-click" scenario NEW-1's own writeup used to justify why the sequential case matters), or the H4 cron worker's retry pass firing at the same moment a human clicks "Retry" on the same stuck message. Neither requires malicious intent or an adversarial client.
- **Why this is High, not Low:** it reproduces the identical customer-facing failure mode NEW-1 was fixed to prevent — a real contact silently receiving a duplicate message — under a trigger condition (genuine request overlap) that is common in production web apps and was not covered by the Builder's own (sequential-only) regression tests. It is a narrower window than the original NEW-1 bug (needs true concurrency, not just any repeat call) but the impact and the "no error surfaced" characteristic are the same.
- **Suggested fix direction (not implemented — verification-only, no source modified):** make the guard-check and the state transition atomic in one round trip, e.g. `messageRepository.updateStatus`-style helper that does `UPDATE "Message" SET status = 'SENDING' WHERE id = $1 AND organizationId = $2 AND status = 'PENDING'` and checks the affected-row count before ever calling `deps.adapter` (only the caller that actually flips the row wins the right to send); the same pattern `resolveOrCreateContactAndConversation`'s H5 fix and the Message-insert idempotency pattern already use elsewhere in this codebase (attempt the write first, treat "someone else already did this" as a normal outcome, not an exception) is directly applicable here.

No other new Critical/High findings surfaced. Everything else probed (message-thread inbound-retry click path, the retry-worker route, cross-file contamination between this round's `auth.ts` and `retry-worker/route.ts` changes) checked out as documented — see below.

### NEW-3 / NEW-4 status — confirmed still accurately Low, not silently worsened

- **NEW-3** (component test mock gap for `retryInboundMessageTranslation` in `message-thread.test.tsx`): re-read the current mock — still only `retryConversationMessage: vi.fn(...)`, `retryInboundMessageTranslation` still absent from it. Re-confirmed the production wiring is correct (`message-thread.tsx` imports and correctly branches on `message.direction === "INBOUND"` to call the right action). Unchanged, correctly still Low — a coverage gap, not a production bug.
- **NEW-4** (retry-worker route's plain `!==` secret comparison + no rate limiter): re-read `src/app/api/internal/retry-worker/route.ts` — unchanged, still `provided !== env.INTERNAL_WORKER_SECRET`, still no rate limiter import. Explicitly checked whether NEW-2's `auth.ts` changes touched this file or anything it imports: they do not — `retry-worker/route.ts` imports `@/server/env`, `@/server/channels`, three repositories, `outboundService`, `retryQueue`, and `@/server/logger`; it does not import `auth.ts`/`authTokenRefresh.ts` at all, and `auth.ts` does not import anything from the retry-worker route or `env.ts`'s `INTERNAL_WORKER_SECRET` handling. No cross-contamination. Unchanged, correctly still Low.

### Overall final verdict

**Zero regressions**: 492/492 tests pass (63/63 files), lint/typecheck/build all clean, identical across two fresh full-suite runs. **NEW-1 and NEW-2 both genuinely hold up** for the exact scenarios they were written to fix, independently re-exercised against real Postgres with fresh, non-reused test code rather than re-reading the Builder's own tests. **NEW-3 and NEW-4 remain accurately Low**, unchanged and undisturbed by this round's other changes.

This pass did surface one new **High** finding, **NEW-5**: `confirmAndSend`/`retryMessage`'s precondition guards are vulnerable to a genuine (independently reproduced, not hypothetical) TOCTOU race under truly concurrent invocation, which can silently double-send a real message to a real contact via an ordinary double-click or a cron-worker/manual-retry overlap — the same customer-facing failure mode NEW-1 was fixed to close, just via a concurrent rather than sequential trigger. This was missed by the Builder's own regression tests because they call the guarded functions sequentially (`await`, then call again), never via genuine overlap (`Promise.all`).

**Verdict: NO-GO on "test coverage and observed correctness" grounds until NEW-5 is addressed or explicitly, consciously accepted as a documented residual-risk MVP limitation by a human sign-off** — this is a materially different bar from the Reviewer's ship verdict, which is about overall product readiness; from a pure testing/correctness standpoint, a reproducible (not edge-case-theoretical) double-send path in the core outbound-messaging guarantee this whole review chain has been scrutinizing hardest is not something I can call fully verified. The fix itself is small and well-precedented (an atomic conditional update, mirroring the H5/idempotency pattern already used successfully elsewhere in this codebase) and does not require another full Plan→Build→Review cycle — but it does warrant one more, narrowly-scoped Builder fix + Tester re-verification pass before this specific guarantee should be signed off as solid. Every other area verified in this pass (NEW-1's two documented scenarios, NEW-2's revocation timing, NEW-3/NEW-4's status, and the full existing 492-test suite) is in genuinely solid, ship-ready shape.

*Final verification generated independently; no application/production source files were modified — only this report was appended to, and all throwaway verification test files were deleted after use (confirmed via `git status` showing a clean tree at every checkpoint).*
