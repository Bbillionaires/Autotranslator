/**
 * Integration tests for the full outbound lifecycle (§3.6) and internal notes, run against
 * a REAL Postgres test database (see ./__tests__/testDb.ts) with the `FakeChannelAdapter`
 * standing in for a real channel — no network call is ever made.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { DetectLanguageResult, TranslateInput, TranslateResult, TranslationProvider } from "../translation/types";
import { configureTestDatabaseEnv } from "./__tests__/testDb";

configureTestDatabaseEnv();

const { prisma } = await import("../db");
const { organizationRepository } = await import("../repositories/organizationRepository");
const { channelAccountRepository } = await import("../repositories/channelAccountRepository");
const { contactRepository } = await import("../repositories/contactRepository");
const { contactChannelIdentityRepository } = await import("../repositories/contactChannelIdentityRepository");
const { conversationRepository } = await import("../repositories/conversationRepository");
const { messageEventRepository } = await import("../repositories/messageEventRepository");
const { FakeChannelAdapter } = await import("../channels/__tests__/fakeAdapter");
const { sendMessage, confirmAndSend, retryMessage, addInternalNote } = await import("./outboundService");
const { DEFAULT_RETRY_POLICY } = await import("./retryQueue");
const { TranslationEngine } = await import("../translation/engine");
const { ConflictError } = await import("../errors");

/** Always throws — simulates a translation-provider outage, same pattern as specialCasesAndFailures.test.ts. */
class FailingProvider implements TranslationProvider {
  readonly name = "openai" as const;
  async detectLanguage(_text: string): Promise<DetectLanguageResult> {
    throw new Error("Simulated OpenAI timeout during detectLanguage");
  }
  async translate(_input: TranslateInput): Promise<TranslateResult> {
    throw new Error("Simulated OpenAI timeout during translate");
  }
}

/**
 * NEW-5 fix verification helper (docs/test-report.md "Final Verification"): a
 * `FakeChannelAdapter` whose `sendMessage` takes an artificial `delayMs` before resolving.
 * Used only by the concurrency tests below, to widen the window between two racing calls'
 * reads/lookups and their eventual adapter call — real Postgres round-trips already yield
 * the event loop enough to interleave two `Promise.all`-launched calls, but this makes that
 * interleaving reliable rather than incidental, so the test genuinely exercises overlap
 * rather than two calls that happen to run back-to-back.
 */
class DelayedFakeChannelAdapter extends FakeChannelAdapter {
  constructor(private readonly delayMs: number, channelType: "TELEGRAM" | "WHATSAPP" | "ANDROID_SMS" = "TELEGRAM") {
    super(channelType);
  }

  override async sendMessage(input: Parameters<InstanceType<typeof FakeChannelAdapter>["sendMessage"]>[0]) {
    await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    return super.sendMessage(input);
  }
}

let organizationId: string;

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  await prisma.$disconnect();
});

afterEach(async () => {
  if (organizationId) {
    await prisma.organization.deleteMany({ where: { id: organizationId } });
  }
});

async function setUpConversation() {
  const organization = await organizationRepository.create({ name: `Outbound Test Org ${Date.now()}-${Math.random()}` });
  organizationId = organization.id;

  const channelAccount = await channelAccountRepository.create(organizationId, {
    channelType: "TELEGRAM",
    displayName: "Test Telegram Bot",
    status: "ACTIVE",
  });

  const contact = await contactRepository.create(organizationId, { displayName: "Bob", preferredLanguage: "es" });

  await contactChannelIdentityRepository.create(organizationId, {
    contactId: contact.id,
    channelAccountId: channelAccount.id,
    externalContactId: "tg_chat_bob",
  });

  const conversation = await conversationRepository.upsertForContactAndChannel(organizationId, contact.id, channelAccount.id);

  return { organization, channelAccount, contact, conversation };
}

describe("sendMessage / confirmAndSend — full outbound lifecycle", () => {
  it("stores the translated draft as PENDING before any send attempt (review-before-send path)", async () => {
    const { conversation } = await setUpConversation();
    const adapter = new FakeChannelAdapter("TELEGRAM");

    const result = await sendMessage(
      { organizationId, conversationId: conversation.id, text: "Hello there", reviewBeforeSend: true },
      { adapter },
    );

    expect(result.outcome).toBe("DRAFT");
    expect(result.message.status).toBe("PENDING");
    expect(result.message.originalText).toBe("Hello there");
    expect(result.message.translatedText).toBe("Hello there"); // noop echoes input
    expect(result.message.targetLanguage).toBe("es"); // contact.preferredLanguage
    expect(result.message.externalMessageId).toBeNull();
    expect(adapter.sentMessages).toHaveLength(0); // never sent while awaiting review
  });

  it("sends immediately (review-before-send off), marking SENT with an externalMessageId and recording a 'sent' MessageEvent", async () => {
    const { conversation } = await setUpConversation();
    const adapter = new FakeChannelAdapter("TELEGRAM");

    const result = await sendMessage({ organizationId, conversationId: conversation.id, text: "Hello there" }, { adapter });

    expect(result.outcome).toBe("SENT");
    expect(result.message.status).toBe("SENT");
    expect(result.message.externalMessageId).toMatch(/^fake-msg-/);
    expect(adapter.sentMessages).toHaveLength(1);
    expect(adapter.sentMessages[0].externalContactId).toBe("tg_chat_bob");

    const sentEvent = await messageEventRepository.findLatestByType(organizationId, result.message.id, "sent");
    expect(sentEvent).not.toBeNull();
    expect(sentEvent?.externalEventId).toBe(result.message.externalMessageId);
  });

  it("confirmAndSend can be called separately to send a previously-drafted (review-before-send) message", async () => {
    const { conversation } = await setUpConversation();
    const adapter = new FakeChannelAdapter("TELEGRAM");

    const draft = await sendMessage(
      { organizationId, conversationId: conversation.id, text: "Draft me", reviewBeforeSend: true },
      { adapter },
    );
    expect(draft.outcome).toBe("DRAFT");

    const confirmed = await confirmAndSend(organizationId, draft.message.id, { adapter });
    expect(confirmed.outcome).toBe("SENT");
    expect(confirmed.message.externalMessageId).toMatch(/^fake-msg-/);
  });

  it("a failed adapter send leaves the message FAILED (never SENT) with a failureReason, and records a 'failed' MessageEvent", async () => {
    const { conversation } = await setUpConversation();
    const adapter = new FakeChannelAdapter("TELEGRAM");
    adapter.queueFailure("permanent", "Invalid recipient");

    const result = await sendMessage({ organizationId, conversationId: conversation.id, text: "This will fail" }, { adapter });

    expect(result.outcome).toBe("FAILED");
    expect(result.message.status).toBe("FAILED");
    expect(result.message.status).not.toBe("SENT");
    expect(result.message.failureReason).toContain("Invalid recipient");
    expect(result.message.externalMessageId).toBeNull();

    const failedEvent = await messageEventRepository.findLatestByType(organizationId, result.message.id, "failed");
    expect(failedEvent).not.toBeNull();

    const sentEvent = await messageEventRepository.findLatestByType(organizationId, result.message.id, "sent");
    expect(sentEvent).toBeNull();
  });
});

describe("retry/backoff reaching DEAD_LETTER", () => {
  it("repeated transient failures eventually reach DEAD_LETTER with a populated failureReason, scheduling a retry_scheduled event each time until the cap", async () => {
    const { conversation } = await setUpConversation();
    const adapter = new FakeChannelAdapter("TELEGRAM");
    adapter.queueFailure("transient");

    let result = await sendMessage({ organizationId, conversationId: conversation.id, text: "Retry me" }, { adapter });
    expect(result.message.status).toBe("FAILED");

    // 1 initial failure (via sendMessage) + maxAttempts more (via retryMessage) exceeds the
    // cap on the (maxAttempts + 1)-th failure, per computeNextRetry's semantics (see
    // retryQueue.test.ts for the exact backoff-sequence math).
    for (let i = 0; i < DEFAULT_RETRY_POLICY.maxAttempts; i += 1) {
      adapter.queueFailure("transient");
      result = await retryMessage(organizationId, result.message.id, { adapter });
    }

    expect(result.outcome).toBe("FAILED");
    expect(result.message.status).toBe("DEAD_LETTER");
    expect(result.message.failureReason).toBeTruthy();
    expect(result.message.failureReason).toContain("Retry attempt cap");

    const events = await messageEventRepository.listByMessage(organizationId, result.message.id);
    const retryScheduledEvents = events.filter((e) => e.eventType === "retry_scheduled");
    expect(retryScheduledEvents).toHaveLength(DEFAULT_RETRY_POLICY.maxAttempts);

    const deadLetterEvent = events.find((e) => e.eventType === "dead_letter");
    expect(deadLetterEvent).toBeDefined();

    // Backoff delay sequence: each successive retry_scheduled event's scheduledFor should
    // be farther out than the last (exponential growth), within the jittered bounds
    // asserted precisely in retryQueue.test.ts.
    const scheduledForTimes = retryScheduledEvents
      .sort((a, b) => (a.payload as { attempt: number }).attempt - (b.payload as { attempt: number }).attempt)
      .map((e) => new Date((e.payload as { scheduledFor: string }).scheduledFor).getTime() - e.createdAt.getTime());
    for (let i = 1; i < scheduledForTimes.length; i += 1) {
      expect(scheduledForTimes[i]).toBeGreaterThan(scheduledForTimes[i - 1] * 0.9); // allow small jitter overlap at the boundary
    }
  });

  it("a permanent failure does not schedule an automatic retry, but stays retryable manually", async () => {
    const { conversation } = await setUpConversation();
    const adapter = new FakeChannelAdapter("TELEGRAM");
    adapter.queueFailure("permanent");

    const result = await sendMessage({ organizationId, conversationId: conversation.id, text: "Permanent failure" }, { adapter });
    expect(result.message.status).toBe("FAILED");

    const retryScheduled = await messageEventRepository.findLatestByType(organizationId, result.message.id, "retry_scheduled");
    expect(retryScheduled).toBeNull();

    // Manual retry is still allowed on a FAILED message.
    const retried = await retryMessage(organizationId, result.message.id, { adapter });
    expect(retried.outcome).toBe("SENT");
  });
});

describe("confirmAndSend precondition guard (NEW-1 fix, docs/review-report.md 'Final Review')", () => {
  it("throws BEFORE calling the adapter when the message is FAILED at the translation step (never leaks raw originalText to the real contact)", async () => {
    const { conversation } = await setUpConversation();
    const adapter = new FakeChannelAdapter("TELEGRAM");
    const failingEngine = new TranslationEngine(new FailingProvider());

    const failed = await sendMessage(
      { organizationId, conversationId: conversation.id, text: "SECRET RAW ENGLISH TEXT" },
      { adapter, engine: failingEngine },
    );
    expect(failed.outcome).toBe("FAILED");
    expect(failed.message.status).toBe("FAILED");
    expect(failed.message.translatedText).toBeNull();
    expect(adapter.sentMessages).toHaveLength(0);

    // Calling confirmAndSend directly (e.g. a stale "Confirm & send" click, or a network
    // retry of that same click) on this translation-FAILED message must throw BEFORE ever
    // touching the adapter — not send the raw, untranslated text and fail only afterward.
    await expect(confirmAndSend(organizationId, failed.message.id, { adapter })).rejects.toThrow(ConflictError);
    await expect(confirmAndSend(organizationId, failed.message.id, { adapter })).rejects.toThrow(
      "Message is not in a sendable state.",
    );

    // The adapter must never have been called — the raw English text was never "sent".
    expect(adapter.sentMessages).toHaveLength(0);
  });

  it("throws on a second confirmAndSend call for an already-SENT message instead of double-sending", async () => {
    const { conversation } = await setUpConversation();
    const adapter = new FakeChannelAdapter("TELEGRAM");

    const draft = await sendMessage(
      { organizationId, conversationId: conversation.id, text: "Confirm me once", reviewBeforeSend: true },
      { adapter },
    );
    expect(draft.outcome).toBe("DRAFT");

    const confirmed = await confirmAndSend(organizationId, draft.message.id, { adapter });
    expect(confirmed.outcome).toBe("SENT");
    expect(adapter.sentMessages).toHaveLength(1);

    // A second confirmAndSend on the same, now-SENT message (double-click / request retry)
    // must throw instead of silently re-invoking the adapter a second time.
    await expect(confirmAndSend(organizationId, draft.message.id, { adapter })).rejects.toThrow(ConflictError);

    // Exactly one adapter call total — no double-send.
    expect(adapter.sentMessages).toHaveLength(1);
  });
});

describe("NEW-5 fix — confirmAndSend/retryMessage are atomic under genuine concurrency (docs/test-report.md 'Final Verification')", () => {
  const ITERATIONS = 10;

  it("confirmAndSend: two genuinely concurrent calls on the same PENDING message result in exactly one adapter send and one clean ConflictError, every time across repeated runs", async () => {
    for (let i = 0; i < ITERATIONS; i += 1) {
      const { organization, conversation } = await setUpConversation();
      // An artificial delay before the adapter actually "sends" widens the race window so
      // both concurrent calls' reads/lookups genuinely interleave before either one's
      // atomic claim runs — the fix's correctness doesn't depend on this (the claim is a
      // single DB statement, atomic regardless of timing), but it makes this test actually
      // exercise the overlap NEW-5 describes rather than two calls that happen to run
      // back-to-back.
      const adapter = new DelayedFakeChannelAdapter(15);

      const draft = await sendMessage(
        { organizationId, conversationId: conversation.id, text: `Concurrent confirm ${i}`, reviewBeforeSend: true },
        { adapter },
      );
      expect(draft.outcome).toBe("DRAFT");

      const results = await Promise.allSettled([
        confirmAndSend(organizationId, draft.message.id, { adapter }),
        confirmAndSend(organizationId, draft.message.id, { adapter }),
      ]);

      // The real, load-bearing assertion: the fake adapter — standing in for the real
      // channel a real contact would receive a message through — was invoked exactly once
      // total across both concurrent calls, never twice.
      expect(adapter.sentMessages).toHaveLength(1);

      const fulfilled = results.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof confirmAndSend>>> => r.status === "fulfilled");
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");

      // Exactly one caller wins (and actually gets SENT back) and exactly one caller loses
      // — cleanly, via ConflictError, not a crash and not a silent no-op.
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(fulfilled[0].value.outcome).toBe("SENT");
      expect(rejected[0].reason).toBeInstanceOf(ConflictError);
      expect((rejected[0].reason as Error).message).toBe("Message is not in a sendable state.");

      // Clean up this iteration's organization immediately — this test creates
      // `ITERATIONS` of them in a single `it`, so leaving that to the file-level `afterEach`
      // (which only knows about the *last* `organizationId` it was pointed at) would leak
      // every earlier iteration's rows into the test database.
      await prisma.organization.deleteMany({ where: { id: organization.id } });
    }
  });

  it("retryMessage: two genuinely concurrent retries on the same FAILED message (simulating the H4 cron worker overlapping a manual 'Retry' click) result in exactly one adapter send and one clean ConflictError, every time across repeated runs", async () => {
    for (let i = 0; i < ITERATIONS; i += 1) {
      const { organization, conversation } = await setUpConversation();
      const failingAdapter = new FakeChannelAdapter("TELEGRAM");
      failingAdapter.queueFailure("permanent");

      // A FAILED message with a populated translatedText — i.e. it failed at the *send*
      // step, not the translation step — so retryMessage goes straight to confirmAndSend
      // (not retryTranslationThenSend) once it wins the claim, matching the Tester's
      // original repro scenario.
      const failed = await sendMessage({ organizationId, conversationId: conversation.id, text: `Retry me concurrently ${i}` }, { adapter: failingAdapter });
      expect(failed.message.status).toBe("FAILED");
      expect(failed.message.translatedText).not.toBeNull();

      const retryAdapter = new DelayedFakeChannelAdapter(15);
      const results = await Promise.allSettled([
        retryMessage(organizationId, failed.message.id, { adapter: retryAdapter }),
        retryMessage(organizationId, failed.message.id, { adapter: retryAdapter }),
      ]);

      expect(retryAdapter.sentMessages).toHaveLength(1);

      const fulfilled = results.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof retryMessage>>> => r.status === "fulfilled");
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(fulfilled[0].value.outcome).toBe("SENT");
      expect(rejected[0].reason).toBeInstanceOf(ConflictError);
      expect((rejected[0].reason as Error).message).toBe("Message is not in a sendable state.");

      await prisma.organization.deleteMany({ where: { id: organization.id } });
    }
  });
});

describe("addInternalNote", () => {
  it("never calls the adapter's sendMessage and never invokes translation", async () => {
    const { conversation } = await setUpConversation();
    const adapter = new FakeChannelAdapter("TELEGRAM");

    const note = await addInternalNote(organizationId, conversation.id, "user_1", "Called the customer, no answer.");

    expect(note.isInternalNote).toBe(true);
    expect(note.direction).toBe("OUTBOUND");
    expect(note.originalText).toBe("Called the customer, no answer.");
    // No translation ever ran for an internal note.
    expect(note.translatedText).toBeNull();
    expect(note.sourceLanguage).toBeNull();
    expect(note.targetLanguage).toBeNull();
    expect(note.translationProvider).toBeNull();
    // The adapter passed in this test scope was never touched.
    expect(adapter.sentMessages).toHaveLength(0);

    const sentEvent = await messageEventRepository.findLatestByType(organizationId, note.id, "sent");
    expect(sentEvent).toBeNull();
    const noteEvent = await messageEventRepository.findLatestByType(organizationId, note.id, "internal_note_added");
    expect(noteEvent).not.toBeNull();
  });
});
