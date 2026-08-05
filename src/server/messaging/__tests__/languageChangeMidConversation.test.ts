/**
 * Integration test for the Tester phase brief's "Contact-language changes during an active
 * conversation" requirement: set a contact's preferred language, exchange a message, change
 * the language mid-conversation (both via `Contact.preferredLanguage` and via a
 * conversation-level `preferredLanguageOverride`), then confirm the NEXT message correctly
 * uses the newly-resolved language while the EARLIER message's stored `sourceLanguage`/
 * `targetLanguage`/`translatedText` are never retroactively mutated.
 *
 * Runs against a REAL Postgres test database (see ../__tests__/testDb.ts) with the
 * `NoopTranslationProvider` (deterministic passthrough, `translatedText === text`,
 * `targetLanguage` == whatever was resolved) so the resolved target language is directly
 * observable on the stored `Message` row without needing to mock an LLM response.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { NormalizedInboundMessage } from "../../channels/types";
import { configureTestDatabaseEnv } from "./testDb";

configureTestDatabaseEnv();

const { prisma } = await import("../../db");
const { organizationRepository } = await import("../../repositories/organizationRepository");
const { channelAccountRepository } = await import("../../repositories/channelAccountRepository");
const { contactRepository } = await import("../../repositories/contactRepository");
const { contactChannelIdentityRepository } = await import("../../repositories/contactChannelIdentityRepository");
const { conversationRepository } = await import("../../repositories/conversationRepository");
const { channelAdapterRegistry } = await import("../../channels");
const { FakeChannelAdapter } = await import("../../channels/__tests__/fakeAdapter");
const { processInboundMessage } = await import("../inboundService");
const { sendMessage } = await import("../outboundService");

let organizationId: string;
let adapter: InstanceType<typeof FakeChannelAdapter>;

beforeAll(async () => {
  await prisma.$connect();
  adapter = new FakeChannelAdapter("TELEGRAM");
  channelAdapterRegistry.registerOverride(adapter);
});

afterAll(async () => {
  channelAdapterRegistry.unregister("TELEGRAM");
  await prisma.$disconnect();
});

afterEach(async () => {
  adapter.reset();
  if (organizationId) {
    await prisma.organization.deleteMany({ where: { id: organizationId } });
  }
});

function buildNormalized(overrides: Partial<NormalizedInboundMessage> = {}): NormalizedInboundMessage {
  return {
    externalContactId: "tg_lang_change_contact",
    externalMessageId: "ext_lang_change_1",
    text: "Hello there",
    sentAt: new Date("2026-08-01T10:00:00Z"),
    raw: {},
    ...overrides,
  };
}

describe("Outbound: contact language change mid-conversation", () => {
  it("a later message uses the NEW resolved target language; the earlier message's stored language/translation is untouched", async () => {
    const organization = await organizationRepository.create({ name: `Lang Change Outbound Org ${Date.now()}-${Math.random()}` });
    organizationId = organization.id;
    const channelAccount = await channelAccountRepository.create(organizationId, {
      channelType: "TELEGRAM",
      displayName: "Test Bot",
      status: "ACTIVE",
    });
    const contact = await contactRepository.create(organizationId, { displayName: "Lang Change Contact", preferredLanguage: "es" });
    await contactChannelIdentityRepository.create(organizationId, {
      contactId: contact.id,
      channelAccountId: channelAccount.id,
      externalContactId: "tg_lang_change_contact",
    });
    const conversation = await conversationRepository.upsertForContactAndChannel(organizationId, contact.id, channelAccount.id);

    // Message 1, while the contact's preferred language is still "es".
    const first = await sendMessage(
      { organizationId, conversationId: conversation.id, text: "First message" },
      { adapter },
    );
    expect(first.outcome).toBe("SENT");
    expect(first.message.targetLanguage).toBe("es");

    // Change the contact's preferred language mid-conversation.
    await contactRepository.updatePreferredLanguage(organizationId, contact.id, "ja");

    // Message 2, sent after the language change.
    const second = await sendMessage(
      { organizationId, conversationId: conversation.id, text: "Second message" },
      { adapter },
    );
    expect(second.outcome).toBe("SENT");
    expect(second.message.targetLanguage).toBe("ja");

    // The FIRST message's stored row must be completely unaffected by the later change —
    // no retroactive mutation of already-sent messages.
    const firstReloaded = await prisma.message.findUniqueOrThrow({ where: { id: first.message.id } });
    expect(firstReloaded.targetLanguage).toBe("es");
    expect(firstReloaded.translatedText).toBe("First message"); // noop passthrough
    expect(firstReloaded.originalText).toBe("First message");

    const secondReloaded = await prisma.message.findUniqueOrThrow({ where: { id: second.message.id } });
    expect(secondReloaded.targetLanguage).toBe("ja");
    expect(secondReloaded.originalText).toBe("Second message");

    expect(adapter.sentMessages).toHaveLength(2);
  });

  it("a conversation-level language override takes priority over the contact's preferred language for the next message, without touching earlier messages", async () => {
    const organization = await organizationRepository.create({ name: `Lang Override Outbound Org ${Date.now()}-${Math.random()}` });
    organizationId = organization.id;
    const channelAccount = await channelAccountRepository.create(organizationId, {
      channelType: "TELEGRAM",
      displayName: "Test Bot",
      status: "ACTIVE",
    });
    const contact = await contactRepository.create(organizationId, { displayName: "Override Contact", preferredLanguage: "es" });
    await contactChannelIdentityRepository.create(organizationId, {
      contactId: contact.id,
      channelAccountId: channelAccount.id,
      externalContactId: "tg_override_contact",
    });
    const conversation = await conversationRepository.upsertForContactAndChannel(organizationId, contact.id, channelAccount.id);

    const first = await sendMessage(
      { organizationId, conversationId: conversation.id, text: "Before override" },
      { adapter },
    );
    expect(first.message.targetLanguage).toBe("es");

    // Set a conversation-level override — this takes priority over Contact.preferredLanguage
    // per the §3.4 resolution chain, even though the contact's own preference is unchanged.
    await conversationRepository.setLanguageOverride(organizationId, conversation.id, "de");

    const second = await sendMessage(
      { organizationId, conversationId: conversation.id, text: "After override" },
      { adapter },
    );
    expect(second.message.targetLanguage).toBe("de");

    const firstReloaded = await prisma.message.findUniqueOrThrow({ where: { id: first.message.id } });
    expect(firstReloaded.targetLanguage).toBe("es"); // untouched by the later override

    // Clearing the override falls back to the contact's preferred language again.
    await conversationRepository.setLanguageOverride(organizationId, conversation.id, null);
    const third = await sendMessage(
      { organizationId, conversationId: conversation.id, text: "After clearing override" },
      { adapter },
    );
    expect(third.message.targetLanguage).toBe("es");
  });
});

describe("Inbound: assigned-user language change mid-conversation (affects which language the inbox is translated into)", () => {
  it("a later inbound message is translated for the NEWLY-assigned user's language; the earlier message keeps its original resolved target", async () => {
    const organization = await organizationRepository.create({ name: `Lang Change Inbound Org ${Date.now()}-${Math.random()}` });
    organizationId = organization.id;
    const channelAccount = await channelAccountRepository.create(organizationId, {
      channelType: "TELEGRAM",
      displayName: "Test Bot",
      status: "ACTIVE",
    });

    const { userRepository } = await import("../../repositories/userRepository");
    const spanishAgent = await userRepository.create({
      organizationId,
      name: "Spanish Agent",
      email: `spanish-agent-${Date.now()}-${Math.random()}@test.dev`,
      role: "AGENT",
      preferredLanguage: "es",
    });
    const japaneseAgent = await userRepository.create({
      organizationId,
      name: "Japanese Agent",
      email: `japanese-agent-${Date.now()}-${Math.random()}@test.dev`,
      role: "AGENT",
      preferredLanguage: "ja",
    });

    // First inbound message arrives before any assignment — this creates the Contact +
    // Conversation. Contact has no preferredLanguage set (unassigned conversation falls
    // back through the chain to the org default).
    const firstResult = await processInboundMessage(
      buildNormalized({ text: "First inbound message", externalMessageId: "ext_lang_change_1" }),
      channelAccount,
    );
    expect(firstResult.message.targetLanguage).toBe(organization.defaultLanguage); // "en"

    // Assign to the Spanish-speaking agent.
    await conversationRepository.assign(organizationId, firstResult.conversation.id, { assignedUserId: spanishAgent.id });

    const secondResult = await processInboundMessage(
      buildNormalized({ text: "Second inbound message", externalMessageId: "ext_lang_change_2" }),
      channelAccount,
    );
    expect(secondResult.message.targetLanguage).toBe("es");

    // Reassign mid-conversation to the Japanese-speaking agent.
    await conversationRepository.assign(organizationId, firstResult.conversation.id, { assignedUserId: japaneseAgent.id });

    const thirdResult = await processInboundMessage(
      buildNormalized({ text: "Third inbound message", externalMessageId: "ext_lang_change_3" }),
      channelAccount,
    );
    expect(thirdResult.message.targetLanguage).toBe("ja");

    // Earlier messages must retain their own originally-resolved targetLanguage — no
    // retroactive re-translation/re-labeling when the assignment changes later.
    const firstReloaded = await prisma.message.findUniqueOrThrow({ where: { id: firstResult.message.id } });
    expect(firstReloaded.targetLanguage).toBe(organization.defaultLanguage);
    const secondReloaded = await prisma.message.findUniqueOrThrow({ where: { id: secondResult.message.id } });
    expect(secondReloaded.targetLanguage).toBe("es");
  });
});
