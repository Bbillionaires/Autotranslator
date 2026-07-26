/**
 * Tests for the conversation-management Server Actions
 * (`assignConversation`/`changeConversationStatus`/`setConversationLanguageOverride`/
 * `setConversationHighRisk`/`addConversationInternalNote`), per
 * docs/implementation-plan.md §5/§6.9. Runs against a REAL Postgres test database (see
 * ../messaging/__tests__/testDb.ts); `../auth`'s `auth()` is mocked, same pattern as
 * contacts.test.ts.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";
import { configureTestDatabaseEnv } from "../messaging/__tests__/testDb";

configureTestDatabaseEnv();

vi.mock("../auth", () => ({ auth: vi.fn(async (): Promise<import("next-auth").Session | null> => null) }));

const auth = (await import("../auth")).auth as unknown as () => Promise<Session | null>;
const { prisma } = await import("../db");
const { organizationRepository } = await import("../repositories/organizationRepository");
const { channelAccountRepository } = await import("../repositories/channelAccountRepository");
const { contactRepository } = await import("../repositories/contactRepository");
const { conversationRepository } = await import("../repositories/conversationRepository");
const { userRepository } = await import("../repositories/userRepository");
const {
  assignConversation,
  changeConversationStatus,
  setConversationLanguageOverride,
  setConversationHighRisk,
  addConversationInternalNote,
} = await import("./conversations");

function fakeSession(role: Session["user"]["role"], organizationId: string, userId = "u1"): Session {
  return { user: { id: userId, organizationId, role }, expires: "" } as Session;
}

let organizationId: string;

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  await prisma.$disconnect();
});

afterEach(async () => {
  vi.mocked(auth).mockReset();
  if (organizationId) {
    await prisma.organization.deleteMany({ where: { id: organizationId } });
  }
});

async function setUpConversation() {
  const organization = await organizationRepository.create({ name: `Conversations Action Test Org ${Date.now()}-${Math.random()}` });
  organizationId = organization.id;

  const channelAccount = await channelAccountRepository.create(organizationId, {
    channelType: "TELEGRAM",
    displayName: "Test Bot",
    status: "ACTIVE",
  });
  const contact = await contactRepository.create(organizationId, { displayName: "Erin" });
  const conversation = await conversationRepository.upsertForContactAndChannel(organizationId, contact.id, channelAccount.id);
  const user = await userRepository.create({ organizationId, name: "Alex Agent", email: `alex-${Date.now()}@test.dev`, role: "AGENT" });
  // The user acting in each test (used as `session.user.id`) — a real row is required
  // because `AuditLog.userId` has a foreign-key constraint against `User`.
  const actingUser = await userRepository.create({
    organizationId,
    name: "Acting Agent",
    email: `acting-${Date.now()}-${Math.random()}@test.dev`,
    role: "AGENT",
  });
  return { conversation, user, actingUser };
}

describe("assignConversation", () => {
  it("rejects a session below Agent (e.g. Viewer)", async () => {
    const { conversation, user } = await setUpConversation();
    vi.mocked(auth).mockResolvedValue(fakeSession("VIEWER", organizationId));

    const result = await assignConversation({ conversationId: conversation.id, assignedUserId: user.id });
    expect(result.ok).toBe(false);

    const unchanged = await conversationRepository.findByIdInOrgOrThrow(organizationId, conversation.id);
    expect(unchanged.assignedUserId).toBeNull();
  });

  it("assigns to a user for an Agent+ session and writes an AuditLog row", async () => {
    const { conversation, user, actingUser } = await setUpConversation();
    vi.mocked(auth).mockResolvedValue(fakeSession("AGENT", organizationId, actingUser.id));

    const result = await assignConversation({ conversationId: conversation.id, assignedUserId: user.id });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.assignedUserId).toBe(user.id);

    const auditRows = await prisma.auditLog.findMany({ where: { organizationId, action: "conversation.reassigned" } });
    expect(auditRows).toHaveLength(1);
  });

  it("rejects assignment to a user from a different organization", async () => {
    const { conversation } = await setUpConversation();
    const otherOrg = await organizationRepository.create({ name: `Other Org ${Date.now()}-${Math.random()}` });
    const otherUser = await userRepository.create({ organizationId: otherOrg.id, name: "Outsider", email: `outsider-${Date.now()}@test.dev` });
    vi.mocked(auth).mockResolvedValue(fakeSession("AGENT", organizationId));

    const result = await assignConversation({ conversationId: conversation.id, assignedUserId: otherUser.id });
    expect(result.ok).toBe(false);

    await prisma.organization.deleteMany({ where: { id: otherOrg.id } });
  });
});

describe("changeConversationStatus", () => {
  it("rejects a session below Agent (e.g. Viewer)", async () => {
    const { conversation } = await setUpConversation();
    vi.mocked(auth).mockResolvedValue(fakeSession("VIEWER", organizationId));

    const result = await changeConversationStatus({ conversationId: conversation.id, status: "RESOLVED" });
    expect(result.ok).toBe(false);
  });

  it("changes status for an Agent+ session", async () => {
    const { conversation } = await setUpConversation();
    vi.mocked(auth).mockResolvedValue(fakeSession("AGENT", organizationId));

    const result = await changeConversationStatus({ conversationId: conversation.id, status: "RESOLVED" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.status).toBe("RESOLVED");
  });
});

describe("setConversationLanguageOverride", () => {
  it("rejects a session below Agent (e.g. Viewer)", async () => {
    const { conversation } = await setUpConversation();
    vi.mocked(auth).mockResolvedValue(fakeSession("VIEWER", organizationId));

    const result = await setConversationLanguageOverride({ conversationId: conversation.id, languageOverride: "de" });
    expect(result.ok).toBe(false);
  });

  it("sets the override for an Agent+ session and writes an AuditLog row", async () => {
    const { conversation, actingUser } = await setUpConversation();
    vi.mocked(auth).mockResolvedValue(fakeSession("AGENT", organizationId, actingUser.id));

    const result = await setConversationLanguageOverride({ conversationId: conversation.id, languageOverride: "de" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.preferredLanguageOverride).toBe("de");

    const auditRows = await prisma.auditLog.findMany({ where: { organizationId, action: "conversation.language_override_changed" } });
    expect(auditRows).toHaveLength(1);
  });
});

describe("setConversationHighRisk", () => {
  it("rejects a session below Agent (e.g. Viewer)", async () => {
    const { conversation } = await setUpConversation();
    vi.mocked(auth).mockResolvedValue(fakeSession("VIEWER", organizationId));

    const result = await setConversationHighRisk({ conversationId: conversation.id, highRisk: true });
    expect(result.ok).toBe(false);
  });

  it("sets the flag for an Agent+ session", async () => {
    const { conversation, actingUser } = await setUpConversation();
    vi.mocked(auth).mockResolvedValue(fakeSession("AGENT", organizationId, actingUser.id));

    const result = await setConversationHighRisk({ conversationId: conversation.id, highRisk: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.highRisk).toBe(true);
  });
});

describe("addConversationInternalNote", () => {
  it("rejects a session below Agent (e.g. Viewer)", async () => {
    const { conversation } = await setUpConversation();
    vi.mocked(auth).mockResolvedValue(fakeSession("VIEWER", organizationId));

    const result = await addConversationInternalNote({ conversationId: conversation.id, text: "Should not be saved" });
    expect(result.ok).toBe(false);
  });

  it("adds an internal note for an Agent+ session, never translated", async () => {
    const { conversation } = await setUpConversation();
    vi.mocked(auth).mockResolvedValue(fakeSession("AGENT", organizationId));

    const result = await addConversationInternalNote({ conversationId: conversation.id, text: "Called the customer." });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.isInternalNote).toBe(true);
    expect(result.data.translatedText).toBeNull();
  });
});
