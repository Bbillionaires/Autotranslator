/**
 * Tests for the outbound-message Server Actions (`sendConversationMessage`,
 * `confirmAndSendConversationMessage`, `retryConversationMessage`), per
 * docs/implementation-plan.md §5. These are the Phase 6 "compose path" wrappers around
 * Phase 5's `outboundService` — verifying they resolve the right adapter via
 * `channelAdapterRegistry` and actually invoke the full outbound lifecycle end-to-end.
 * `FakeChannelAdapter` stands in for a real channel (no network call); `../auth`'s `auth()`
 * is mocked. Runs against a REAL Postgres test database (see ../messaging/__tests__/testDb.ts).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";
import { configureTestDatabaseEnv } from "../messaging/__tests__/testDb";

configureTestDatabaseEnv();

vi.mock("../auth", () => ({ auth: vi.fn(async (): Promise<import("next-auth").Session | null> => null) }));

// See src/server/actions/contacts.test.ts for why `auth` is cast to a single signature here.
const auth = (await import("../auth")).auth as unknown as () => Promise<Session | null>;
const { prisma } = await import("../db");
const { organizationRepository } = await import("../repositories/organizationRepository");
const { channelAccountRepository } = await import("../repositories/channelAccountRepository");
const { contactRepository } = await import("../repositories/contactRepository");
const { contactChannelIdentityRepository } = await import("../repositories/contactChannelIdentityRepository");
const { conversationRepository } = await import("../repositories/conversationRepository");
const { userRepository } = await import("../repositories/userRepository");
const { channelAdapterRegistry } = await import("../channels");
const { FakeChannelAdapter } = await import("../channels/__tests__/fakeAdapter");
const { sendConversationMessage, confirmAndSendConversationMessage, retryConversationMessage, recordTranslationEdit } = await import(
  "./messages"
);

function fakeSession(role: Session["user"]["role"], organizationId: string, userId = "u1"): Session {
  return { user: { id: userId, organizationId, role }, expires: "" } as Session;
}

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
  vi.mocked(auth).mockReset();
  adapter.reset();
  if (organizationId) {
    await prisma.organization.deleteMany({ where: { id: organizationId } });
  }
});

async function setUpConversation() {
  const organization = await organizationRepository.create({ name: `Messages Action Test Org ${Date.now()}-${Math.random()}` });
  organizationId = organization.id;

  const channelAccount = await channelAccountRepository.create(organizationId, {
    channelType: "TELEGRAM",
    displayName: "Test Telegram Bot",
    status: "ACTIVE",
  });
  const contact = await contactRepository.create(organizationId, { displayName: "Erin", preferredLanguage: "es" });
  await contactChannelIdentityRepository.create(organizationId, {
    contactId: contact.id,
    channelAccountId: channelAccount.id,
    externalContactId: "tg_erin",
  });
  const conversation = await conversationRepository.upsertForContactAndChannel(organizationId, contact.id, channelAccount.id);
  return { conversation };
}

describe("sendConversationMessage", () => {
  it("rejects a session below Agent", async () => {
    const { conversation } = await setUpConversation();
    vi.mocked(auth).mockResolvedValue(fakeSession("VIEWER", organizationId));

    const result = await sendConversationMessage({ conversationId: conversation.id, text: "Hi" });
    expect(result.ok).toBe(false);
    expect(adapter.sentMessages).toHaveLength(0);
  });

  it("sends a message through the registered adapter for an Agent+ session", async () => {
    const { conversation } = await setUpConversation();
    vi.mocked(auth).mockResolvedValue(fakeSession("AGENT", organizationId));

    const result = await sendConversationMessage({ conversationId: conversation.id, text: "Hello Erin" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.outcome).toBe("SENT");
    expect(adapter.sentMessages).toHaveLength(1);
    expect(adapter.sentMessages[0].externalContactId).toBe("tg_erin");
  });

  it("rejects empty message text via the Zod schema", async () => {
    const { conversation } = await setUpConversation();
    vi.mocked(auth).mockResolvedValue(fakeSession("AGENT", organizationId));

    const result = await sendConversationMessage({ conversationId: conversation.id, text: "" });
    expect(result.ok).toBe(false);
  });
});

describe("confirmAndSendConversationMessage", () => {
  it("sends a previously-drafted (review-before-send) message", async () => {
    const { conversation } = await setUpConversation();
    vi.mocked(auth).mockResolvedValue(fakeSession("AGENT", organizationId));

    const draft = await sendConversationMessage({ conversationId: conversation.id, text: "Draft", reviewBeforeSend: true });
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;
    expect(draft.data.outcome).toBe("DRAFT");
    expect(adapter.sentMessages).toHaveLength(0);

    const confirmed = await confirmAndSendConversationMessage({ messageId: draft.data.message.id });
    expect(confirmed.ok).toBe(true);
    if (!confirmed.ok) return;
    expect(confirmed.data.outcome).toBe("SENT");
    expect(adapter.sentMessages).toHaveLength(1);
  });
});

describe("recordTranslationEdit", () => {
  it("rejects a session below Agent", async () => {
    const { conversation } = await setUpConversation();
    vi.mocked(auth).mockResolvedValue(fakeSession("AGENT", organizationId));
    const draft = await sendConversationMessage({ conversationId: conversation.id, text: "Draft", reviewBeforeSend: true });
    if (!draft.ok) throw new Error("setup failed");

    vi.mocked(auth).mockResolvedValue(fakeSession("VIEWER", organizationId));
    const result = await recordTranslationEdit({ messageId: draft.data.message.id, translatedText: "Edited" });
    expect(result.ok).toBe(false);
  });

  it("persists an edited translation on a PENDING draft and marks translationEdited", async () => {
    const { conversation } = await setUpConversation();
    const actingAgent = await userRepository.create({
      organizationId,
      name: "Acting Agent",
      email: `acting-agent-${Date.now()}-${Math.random()}@test.dev`,
      role: "AGENT",
    });
    vi.mocked(auth).mockResolvedValue(fakeSession("AGENT", organizationId, actingAgent.id));
    const draft = await sendConversationMessage({ conversationId: conversation.id, text: "Draft", reviewBeforeSend: true });
    if (!draft.ok) throw new Error("setup failed");

    const result = await recordTranslationEdit({ messageId: draft.data.message.id, translatedText: "Manually corrected" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.translatedText).toBe("Manually corrected");
    expect(result.data.translationEdited).toBe(true);
  });
});

describe("retryConversationMessage", () => {
  it("re-attempts a FAILED message and succeeds once the adapter stops failing", async () => {
    const { conversation } = await setUpConversation();
    vi.mocked(auth).mockResolvedValue(fakeSession("AGENT", organizationId));

    adapter.queueFailure("permanent", "simulated failure");
    const failed = await sendConversationMessage({ conversationId: conversation.id, text: "Will fail" });
    expect(failed.ok).toBe(true);
    if (!failed.ok) return;
    expect(failed.data.outcome).toBe("FAILED");

    const retried = await retryConversationMessage({ messageId: failed.data.message.id });
    expect(retried.ok).toBe(true);
    if (!retried.ok) return;
    expect(retried.data.outcome).toBe("SENT");
  });
});
