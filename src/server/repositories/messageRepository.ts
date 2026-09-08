/**
 * Org-scoped repository for `Message`, per docs/implementation-plan.md §6.1 and §4's
 * idempotency design: `Message.idempotencyKey` is unique per organization
 * (`@@unique([organizationId, idempotencyKey])`) and is the single mechanism both the
 * inbound (§3.5) and outbound (§3.6) lifecycles rely on to avoid double-processing a
 * retried webhook or a retried compose call. `messagingService`/`inboundService` /
 * `outboundService` are expected to *attempt* `create()` and catch the resulting P2002
 * (see `isUniqueConstraintViolation` in `../db`) rather than pre-checking with
 * `findByIdempotencyKey` first — that's what makes the dedupe race-safe under concurrent
 * webhook retries.
 */
import type { ChannelType, MessageDirection, MessageStatus, Prisma, SenderType } from "@prisma/client";
import { prisma } from "../db";
import type { PrismaClientOrTx } from "../db";
import { NotFoundError } from "../errors";

export interface CreateMessageInput {
  organizationId: string;
  conversationId: string;
  senderType: SenderType;
  direction: MessageDirection;
  originalText: string;
  translatedText?: string | null;
  sourceLanguage?: string | null;
  targetLanguage?: string | null;
  translationProvider?: string | null;
  translationConfidence?: number | null;
  translationEdited?: boolean;
  channelType: ChannelType;
  externalMessageId?: string | null;
  externalReplyToId?: string | null;
  status: MessageStatus;
  failureReason?: string | null;
  idempotencyKey: string;
  isInternalNote?: boolean;
}

export const messageRepository = {
  async findByIdInOrg(organizationId: string, id: string, client: PrismaClientOrTx = prisma) {
    return client.message.findFirst({ where: { id, organizationId } });
  },

  async findByIdInOrgOrThrow(organizationId: string, id: string, client: PrismaClientOrTx = prisma) {
    const message = await client.message.findFirst({ where: { id, organizationId } });
    if (!message) {
      throw new NotFoundError("Message not found.", { organizationId, id });
    }
    return message;
  },

  /**
   * Looked up after a `create()` throws a unique-constraint violation on
   * `(organizationId, idempotencyKey)` — the record that already exists is the "current
   * state" a duplicate webhook or double-submit short-circuits to.
   */
  async findByIdempotencyKey(organizationId: string, idempotencyKey: string, client: PrismaClientOrTx = prisma) {
    return client.message.findUnique({
      where: { organizationId_idempotencyKey: { organizationId, idempotencyKey } },
    });
  },

  async create(input: CreateMessageInput, client: PrismaClientOrTx = prisma) {
    return client.message.create({ data: input });
  },

  /**
   * Looks up a `Message` by its `externalMessageId` (indexed but not unique — see
   * `@@index([externalMessageId])` in the schema), scoped to the caller's org. Used by
   * `../messaging/deliveryStatusService.ts` to resolve which outbound `Message` a WhatsApp
   * `statuses[]` webhook callback (keyed by the WhatsApp message id) refers to. Returns the
   * first match; in the extremely unlikely event of a collision within one org (this MVP
   * doesn't enforce uniqueness on this column), the caller gets a deterministic pick rather
   * than an error.
   */
  async findByExternalMessageId(organizationId: string, externalMessageId: string, client: PrismaClientOrTx = prisma) {
    return client.message.findFirst({ where: { organizationId, externalMessageId } });
  },

  async updateStatus(
    organizationId: string,
    id: string,
    status: MessageStatus,
    extra: { failureReason?: string | null; externalMessageId?: string | null } = {},
    client: PrismaClientOrTx = prisma,
  ) {
    const result = await client.message.updateMany({
      where: { id, organizationId },
      data: { status, ...extra },
    });
    if (result.count === 0) {
      throw new NotFoundError("Message not found.", { organizationId, id });
    }
    return messageRepository.findByIdInOrgOrThrow(organizationId, id, client);
  },

  /**
   * NEW-5 fix (docs/test-report.md "Final Verification"): the atomic primitive
   * `outboundService.confirmAndSend` (`PENDING -> SENDING`, immediately before the adapter
   * call) and `outboundService.retryMessage` (`FAILED`/`DEAD_LETTER` -> `PENDING`) use to
   * make their precondition guard database-enforced instead of a check-then-act race in
   * application memory. Unlike `updateStatus` above — whose `WHERE` clause has no status
   * predicate at all — this issues a single conditional `UPDATE ... WHERE id = $1 AND
   * organizationId = $2 AND status IN (...)`. Postgres's own row-level locking during that
   * one statement is what makes it atomic: among any number of genuinely concurrent callers
   * racing this same `(id, fromStatus)` pair, at most one `updateMany` can ever match and
   * flip the row — this is enforced by the database, not an in-process lock/mutex (which
   * would not close the race across multiple server instances/serverless invocations).
   *
   * Returns the updated `Message` when this call won the race (`result.count === 1`), or
   * `null` when it lost (`result.count === 0` — the row's status had already moved to
   * something outside `fromStatus` by the time this `UPDATE` ran, meaning some other caller
   * got there first). Callers are expected to treat `null` as "throw `ConflictError`, do not
   * proceed" — in particular, never call the channel adapter after a `null` result.
   */
  async claimForTransition(
    organizationId: string,
    id: string,
    fromStatus: MessageStatus | readonly MessageStatus[],
    toStatus: MessageStatus,
    extra: { failureReason?: string | null; externalMessageId?: string | null } = {},
    client: PrismaClientOrTx = prisma,
  ) {
    const result = await client.message.updateMany({
      where: {
        id,
        organizationId,
        status: Array.isArray(fromStatus) ? { in: fromStatus } : (fromStatus as MessageStatus),
      },
      data: { status: toStatus, ...extra },
    });
    if (result.count === 0) {
      return null;
    }
    return messageRepository.findByIdInOrgOrThrow(organizationId, id, client);
  },

  /**
   * T1 fix (docs/test-report.md): completes a `Message` row's translation fields after it
   * was already stored (as `PENDING`, `originalText`-only) *before* the translation call
   * was attempted — the "store first" discipline now shared by both the inbound and
   * outbound lifecycles. Called once `TranslationEngine.detectLanguage()`/`.translate()`
   * actually succeeds, whether on the first attempt or a later manual retry. `status` is
   * caller-supplied (not defaulted here) since the two callers need different targets:
   * `inboundService.ts` moves `PENDING -> DELIVERED`; `outboundService.ts` leaves the
   * message `PENDING` (still awaiting either the review-before-send gate or an immediate
   * send attempt) — the transition itself is validated by the caller via
   * `assertValidTransition` before this is called, same discipline as `updateStatus`.
   */
  async updateTranslationResult(
    organizationId: string,
    id: string,
    data: {
      status: MessageStatus;
      translatedText: string;
      sourceLanguage: string;
      targetLanguage: string;
      translationProvider: string;
      translationConfidence: number;
    },
    client: PrismaClientOrTx = prisma,
  ) {
    const result = await client.message.updateMany({
      where: { id, organizationId },
      data,
    });
    if (result.count === 0) {
      throw new NotFoundError("Message not found.", { organizationId, id });
    }
    return messageRepository.findByIdInOrgOrThrow(organizationId, id, client);
  },

  async markTranslationEdited(
    organizationId: string,
    id: string,
    translatedText: string,
    client: PrismaClientOrTx = prisma,
  ) {
    const result = await client.message.updateMany({
      where: { id, organizationId },
      data: { translatedText, translationEdited: true },
    });
    if (result.count === 0) {
      throw new NotFoundError("Message not found.", { organizationId, id });
    }
    return messageRepository.findByIdInOrgOrThrow(organizationId, id, client);
  },

  async listByConversation(
    organizationId: string,
    conversationId: string,
    options: { cursor?: string; take?: number } = {},
    client: PrismaClientOrTx = prisma,
  ) {
    return client.message.findMany({
      where: { organizationId, conversationId },
      orderBy: { createdAt: "asc" },
      take: options.take ?? 50,
      ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
    });
  },

  /**
   * T1 fix (docs/test-report.md): scoped to `direction: "OUTBOUND"` — a `FAILED` INBOUND
   * message (a translation failure on receipt; see `inboundService.ts`) is deliberately
   * NOT eligible for this automatic worker, since `outboundService.retryMessage`'s retry
   * path assumes a send-oriented retry (resolve the conversation's adapter, call
   * `confirmAndSend`), which doesn't apply to a message with no send step at all. Inbound
   * translation-failure retries are manual only — see `inboundService.retryInboundTranslation`
   * and its doc comment for the full rationale.
   */
  async listFailedAwaitingRetry(
    organizationId: string,
    client: PrismaClientOrTx = prisma,
  ): Promise<Array<Prisma.MessageGetPayload<{ include: { events: true } }>>> {
    return client.message.findMany({
      where: { organizationId, status: "FAILED", direction: "OUTBOUND", isInternalNote: false },
      include: { events: { where: { eventType: "retry_scheduled" }, orderBy: { createdAt: "desc" } } },
    });
  },

  /**
   * Cross-org variant of `listFailedAwaitingRetry` above — the H4 fix's one legitimate
   * exception to "every repository function takes the caller's organizationId" (same
   * precedent as `channelAccountRepository.findById`, used to bootstrap a request before its
   * organizationId is known).
   * Used ONLY by `GET/POST /api/internal/retry-worker` (`src/app/api/internal/retry-worker/
   * route.ts`), which is not a per-org session request — it's an internal, shared-secret
   * protected endpoint an external scheduler hits periodically to drive automatic retries
   * for EVERY organization in one pass (per docs/implementation-plan.md §3.6 step 8's
   * "automatic retry/backoff" requirement, which was previously never actually invoked at
   * runtime — see H4 in docs/review-report.md). Each returned row still carries its own
   * `organizationId`, so the caller re-derives org-scoping per message before calling
   * `outboundService.retryMessage(organizationId, messageId, ...)` — this method itself
   * never bypasses org-scoping for the actual retry/send call, only for the initial
   * "what's due" query.
   *
   * T1 fix (docs/test-report.md): also scoped to `direction: "OUTBOUND"` — see
   * `listFailedAwaitingRetry`'s doc comment above for why a `FAILED` INBOUND (translation
   * failure) message must never reach this automatic, send-oriented retry worker.
   */
  async listAllFailedAwaitingRetryAcrossOrgs(
    client: PrismaClientOrTx = prisma,
  ): Promise<Array<Prisma.MessageGetPayload<{ include: { events: true } }>>> {
    return client.message.findMany({
      where: { status: "FAILED", direction: "OUTBOUND", isInternalNote: false },
      include: { events: { where: { eventType: "retry_scheduled" }, orderBy: { createdAt: "desc" } } },
    });
  },

  /**
   * `GET /api/gateways/messages/pending`, per docs/implementation-plan.md §5/Phase 8: the
   * outbound messages a specific Android gateway device (`channelAccountId`) should pick up
   * next. Scoped by BOTH `organizationId` AND `conversation.channelAccountId` so one org's
   * (or one device's) pending queue never leaks another's — a device only ever sees
   * messages queued for conversations that belong to its own `ChannelAccount` row.
   * Oldest-first (`createdAt: "asc"`) so a device that's been offline drains its backlog in
   * send order once it reconnects; `take` is capped by the caller (route handler) to a
   * reasonable page size.
   */
  async listQueuedForChannelAccount(
    organizationId: string,
    channelAccountId: string,
    options: { take?: number } = {},
    client: PrismaClientOrTx = prisma,
  ) {
    return client.message.findMany({
      where: {
        organizationId,
        status: "QUEUED",
        direction: "OUTBOUND",
        isInternalNote: false,
        conversation: { channelAccountId },
      },
      orderBy: { createdAt: "asc" },
      take: Math.min(options.take ?? 50, 100),
      include: { conversation: { include: { contact: true } } },
    });
  },

  /**
   * Loads a `Message` for a gateway acknowledge/fail call, verifying it belongs to the
   * calling device's own `ChannelAccount` (via its conversation) — not just the same
   * organization. Multiple Android devices can share an org (Phase 8 deliverable #7: no
   * "the one device" shortcut), so org-scoping alone isn't enough to stop one device from
   * acknowledging/failing another device's queued message; this is the device-isolation
   * check both `/acknowledge` and `/fail` rely on. Returns `null` (not a thrown error) when
   * the message doesn't belong to this device, so callers can return a uniform 404 without
   * leaking whether the id exists at all under a different device.
   */
  async findForChannelAccountOrNull(
    organizationId: string,
    channelAccountId: string,
    messageId: string,
    client: PrismaClientOrTx = prisma,
  ) {
    return client.message.findFirst({
      where: { id: messageId, organizationId, conversation: { channelAccountId } },
    });
  },
};
