/**
 * Integration tests for the full outbound lifecycle (§3.6) and internal notes, run against
 * a REAL Postgres test database (see ./__tests__/testDb.ts) with the `FakeChannelAdapter`
 * standing in for a real channel — no network call is ever made.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
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
