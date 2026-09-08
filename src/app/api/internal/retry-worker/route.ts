/**
 * `GET`/`POST /api/internal/retry-worker` — H4 fix (docs/review-report.md).
 *
 * `runRetryWorkerOnce` (`src/server/messaging/retryQueue.ts`) — the pure "find due FAILED
 * messages and re-attempt them" logic — existed and was fully tested, but nothing in the
 * deployed app ever called it: a transient failure (a Telegram 5xx, a network blip) would
 * sit as `FAILED` forever unless a human noticed and clicked "Retry". This route is the
 * missing entrypoint: an external scheduler (Vercel Cron, a self-hosted `node-cron`/systemd
 * timer, a plain `curl` in a cron job, ...) hits this route periodically (e.g. every 1-5
 * minutes) to drive one polling pass across EVERY organization's FAILED messages in this
 * deployment.
 *
 * ## Auth: shared-secret header, not a public unauthenticated endpoint
 * Protected by `INTERNAL_WORKER_SECRET` (optional-but-recommended, `src/server/env.ts`) —
 * the caller must send `X-Internal-Worker-Secret: <the same value>`. If the env var isn't
 * configured at all, this route refuses to run (`503`) rather than operating
 * unauthenticated — there is no "insecure but functional" fallback. If the header is
 * missing/wrong, `401`. Both branches return the exact same generic body, matching the
 * "safe, generic errors" precedent used by every other auth-guarded surface in this
 * codebase (`androidAuth.ts`, `requireRole`).
 *
 * ## Why GET and POST both work
 * Some schedulers (a plain `curl -X GET` in a crontab, certain "hit this URL" style
 * uptime/cron services) most naturally issue a GET; Vercel Cron issues a GET too. Others
 * (webhook-style schedulers) prefer POST. Both run the identical logic — this endpoint has
 * no request BODY to speak of either way (the shared secret travels in a header, not a
 * body), so there's no meaningful difference between the two verbs here.
 *
 * ## Cross-org by design
 * Unlike every other Route Handler in this codebase, this one is NOT a per-org session
 * request — it has no `organizationId` to scope to, by design (it's meant to process every
 * organization's due retries in one pass, since a real deployment runs one scheduler for
 * the whole app, not one per org). See `messageRepository.listAllFailedAwaitingRetryAcrossOrgs`'s
 * doc comment for why this is a deliberate, narrowly-scoped exception to the "always
 * org-scoped" repository discipline (§6.1) — each message's own `organizationId` is still
 * used to re-scope the actual retry/send call.
 *
 * See README.md's "Scheduling the retry worker in production" section for
 * Vercel Cron / self-hosted cron config examples.
 *
 * ## NEW-4 fix (docs/test-report.md): constant-time secret comparison + rate limiting
 * The shared-secret comparison below uses `node:crypto`'s `timingSafeEqual` instead of a
 * plain `!==`, matching every other secret/signature comparison in this codebase (Telegram
 * webhook secret, WhatsApp HMAC/verify-token, Android device-token hash) — each of those
 * keeps its own small self-contained `constantTimeEquals` copy rather than a shared
 * abstraction (see e.g. `androidAuth.ts`'s doc comment on that helper), so this route follows
 * that same established precedent instead of introducing a new cross-cutting module for one
 * more call site. This route is also now rate-limited (`webhookRateLimiter`, the same generic
 * limiter every other public/webhook-adjacent route already uses) — it's a public HTTP route
 * guarded only by a static shared secret, so it deserves the same flood protection.
 */
import { timingSafeEqual } from "node:crypto";
import { channelAdapterRegistry } from "@/server/channels";
import { env } from "@/server/env";
import { conversationRepository } from "@/server/repositories/conversationRepository";
import { channelAccountRepository } from "@/server/repositories/channelAccountRepository";
import { messageRepository } from "@/server/repositories/messageRepository";
import { retryMessage } from "@/server/messaging/outboundService";
import { runRetryWorkerOnce, type RetryableMessageLike } from "@/server/messaging/retryQueue";
import { withContext } from "@/server/logger";
import { getClientIp, rateLimitedResponse, webhookRateLimiter } from "@/server/rateLimit";

function unauthorized(): Response {
  return Response.json({ error: "unauthorized" }, { status: 401 });
}

/**
 * Constant-time string comparison — same pattern as `TelegramAdapter`'s/`WhatsAppAdapter`'s/
 * `androidAuth.ts`'s local `constantTimeEquals` (one small self-contained copy per file,
 * matching that established precedent rather than a premature shared abstraction). Falls
 * back to comparing a buffer against itself on length mismatch (still constant-time for that
 * buffer's length) since `timingSafeEqual` requires equal-length inputs and an early
 * `return false` on length mismatch would itself leak the secret's length via timing.
 */
function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

async function handle(req: Request): Promise<Response> {
  // NEW-4 fix: rate-limited per-IP, before any secret check or DB/adapter work — a flood
  // (valid or invalid secret) shouldn't get further than this, same precedent as the
  // Telegram/WhatsApp webhook routes.
  const rateLimit = webhookRateLimiter.check(getClientIp(req));
  if (!rateLimit.allowed) {
    return rateLimitedResponse();
  }

  if (!env.INTERNAL_WORKER_SECRET) {
    // Fail closed: no "insecure but functional" fallback for an internal, cross-org endpoint.
    return Response.json({ error: "Retry worker is not configured (INTERNAL_WORKER_SECRET unset)." }, { status: 503 });
  }

  const provided = req.headers.get("x-internal-worker-secret");
  if (!provided || !constantTimeEquals(provided, env.INTERNAL_WORKER_SECRET)) {
    return unauthorized();
  }

  const log = withContext({});

  // Snapshot every organization's due-for-retry FAILED messages once, up front — the
  // injected `retryMessage` closure below looks messages up from this same snapshot rather
  // than re-querying per message, since `runRetryWorkerOnce` only needs `{id, events}` to
  // decide "is this due", and the org/channel-account resolution happens here, at the one
  // point that actually calls `outboundService.retryMessage`.
  const dueCandidates = await messageRepository.listAllFailedAwaitingRetryAcrossOrgs();
  const byId = new Map(dueCandidates.map((message) => [message.id, message]));

  const result = await runRetryWorkerOnce({
    findFailedAwaitingRetry: async (): Promise<RetryableMessageLike[]> => dueCandidates,
    retryMessage: async (messageId: string) => {
      const message = byId.get(messageId);
      if (!message) {
        // Unreachable in practice (the id came from this same snapshot), but don't let a
        // stale-lookup bug silently no-op a retry.
        throw new Error(`retry-worker: message ${messageId} vanished from its own snapshot`);
      }
      const conversation = await conversationRepository.findByIdInOrgOrThrow(message.organizationId, message.conversationId);
      const channelAccount = await channelAccountRepository.findByIdInOrgOrThrow(message.organizationId, conversation.channelAccountId);
      const adapter = channelAdapterRegistry.getOrThrow(channelAccount.channelType);
      return retryMessage(message.organizationId, messageId, { adapter });
    },
  });

  log.info(result, "retry_worker_pass_complete");
  return Response.json({ ok: true, ...result }, { status: 200 });
}

export async function GET(req: Request): Promise<Response> {
  return handle(req);
}

export async function POST(req: Request): Promise<Response> {
  return handle(req);
}
