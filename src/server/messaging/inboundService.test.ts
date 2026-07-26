/**
 * Integration tests for the full inbound lifecycle (§3.5), run against a REAL Postgres
 * test database (`autotranslator_test`, the same docker-compose Postgres container as dev
 * — see ./__tests__/testDb.ts) rather than a mocked Prisma client, per
 * docs/implementation-plan.md §9's integration-testing strategy. Uses the
 * `NoopTranslationProvider` (via `TRANSLATION_PROVIDER=noop`, set by `testDb.ts`) so
 * translation output is deterministic and no external API call is made.
 *
 * If `autotranslator_test` isn't reachable, these tests fail with a connection error
 * rather than silently skipping — see the Phase 5 report for how to stand the DB up
 * (`docker compose up -d`, then `prisma migrate deploy` against the test database).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { NormalizedInboundMessage } from "../channels/types";
import { configureTestDatabaseEnv } from "./__tests__/testDb";

configureTestDatabaseEnv();

const { prisma } = await import("../db");
const { organizationRepository } = await import("../repositories/organizationRepository");
const { channelAccountRepository } = await import("../repositories/channelAccountRepository");
const { processInboundMessage } = await import("./inboundService");

let organizationId: string;

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  await prisma.$disconnect();
});

afterEach(async () => {
  // Organization delete cascades to every tenant-scoped row (Contact, ChannelAccount,
  // Conversation, Message, MessageEvent via Message) per the schema's onDelete: Cascade —
  // see docs/implementation-plan.md §4.
  if (organizationId) {
    await prisma.organization.deleteMany({ where: { id: organizationId } });
  }
});

async function setUpOrgAndChannel() {
  const organization = await organizationRepository.create({ name: `Inbound Test Org ${Date.now()}-${Math.random()}` });
  organizationId = organization.id;
  const channelAccount = await channelAccountRepository.create(organizationId, {
    channelType: "TELEGRAM",
    displayName: "Test Telegram Bot",
    status: "ACTIVE",
  });
  return { organization, channelAccount };
}

function buildNormalized(overrides: Partial<NormalizedInboundMessage> = {}): NormalizedInboundMessage {
  return {
    externalContactId: "tg_chat_1",
    externalUsername: "alice",
    externalMessageId: "ext_msg_1",
    text: "Hola, como estas?",
    sentAt: new Date("2026-07-26T12:00:00Z"),
    raw: { update_id: 1 },
    ...overrides,
  };
}

describe("processInboundMessage — full lifecycle", () => {
  it("creates a new Contact + ContactChannelIdentity + Conversation on the first message", async () => {
    const { channelAccount } = await setUpOrgAndChannel();
    const normalized = buildNormalized();

    const result = await processInboundMessage(normalized, channelAccount);

    expect(result.wasDuplicate).toBe(false);
    expect(result.contact.displayName).toBe("alice");
    // preferredLanguage was unset -> detectLanguage ran (noop -> "en") and was stored.
    expect(result.contact.detectedLanguage).toBe("en");

    const identity = await prisma.contactChannelIdentity.findFirst({
      where: { channelAccountId: channelAccount.id, externalContactId: "tg_chat_1" },
    });
    expect(identity).not.toBeNull();
    expect(identity?.contactId).toBe(result.contact.id);

    expect(result.conversation.contactId).toBe(result.contact.id);
    expect(result.conversation.channelAccountId).toBe(channelAccount.id);
    expect(result.conversation.lastMessageAt?.toISOString()).toBe(normalized.sentAt.toISOString());

    // Message row shape: original/translated text, languages, provider, status.
    expect(result.message.originalText).toBe("Hola, como estas?");
    expect(result.message.translatedText).toBe("Hola, como estas?"); // noop echoes input
    expect(result.message.sourceLanguage).toBe("en");
    expect(result.message.targetLanguage).toBe("en"); // org default
    expect(result.message.translationProvider).toBe("noop");
    expect(result.message.status).toBe("DELIVERED");
    expect(result.message.direction).toBe("INBOUND");
    expect(result.message.senderType).toBe("CONTACT");
    expect(result.message.channelType).toBe("TELEGRAM");

    const receivedEvent = await prisma.messageEvent.findFirst({
      where: { messageId: result.message.id, eventType: "received" },
    });
    expect(receivedEvent).not.toBeNull();
  });

  it("reuses the existing Contact + Conversation on a second message from the same external contact", async () => {
    const { channelAccount } = await setUpOrgAndChannel();
    const first = await processInboundMessage(buildNormalized({ externalMessageId: "ext_msg_1" }), channelAccount);

    const second = await processInboundMessage(
      buildNormalized({ externalMessageId: "ext_msg_2", text: "Segundo mensaje" }),
      channelAccount,
    );

    expect(second.wasDuplicate).toBe(false);
    expect(second.contact.id).toBe(first.contact.id);
    expect(second.conversation.id).toBe(first.conversation.id);
    expect(second.message.id).not.toBe(first.message.id);

    const messageCount = await prisma.message.count({ where: { conversationId: first.conversation.id } });
    expect(messageCount).toBe(2);

    // lastMessageAt bumped to the second message's sentAt.
    const conversation = await prisma.conversation.findUniqueOrThrow({ where: { id: first.conversation.id } });
    expect(conversation.lastMessageAt?.toISOString()).toBe(
      buildNormalized({ externalMessageId: "ext_msg_2" }).sentAt.toISOString(),
    );
  });

  it("a duplicate inbound webhook (same channelAccountId + externalMessageId) results in exactly one Message row", async () => {
    const { channelAccount } = await setUpOrgAndChannel();
    const normalized = buildNormalized({ externalMessageId: "ext_dup_1" });

    const first = await processInboundMessage(normalized, channelAccount);
    expect(first.wasDuplicate).toBe(false);

    // Re-deliver the exact same webhook payload (as a retrying webhook sender would).
    const second = await processInboundMessage(normalized, channelAccount);

    expect(second.wasDuplicate).toBe(true);
    expect(second.message.id).toBe(first.message.id);

    const messageCount = await prisma.message.count({ where: { conversationId: first.conversation.id } });
    expect(messageCount).toBe(1);
  });
});
