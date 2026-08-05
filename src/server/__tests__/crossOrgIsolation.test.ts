/**
 * Adversarial multi-organization data-isolation test, per the Tester phase brief's
 * "Multiple organizations / strict data isolation" requirement — the single most
 * emphasized item, given the independent review's C1 finding (Telegram cross-org
 * leakage, now fixed — see telegram/webhook/route.test.ts's dedicated C1 tests).
 *
 * This file does NOT re-test C1 (already covered end-to-end at the route level). Instead
 * it fills the gap the review/Tester brief calls out: proving org isolation for every
 * OTHER Server Action surface that accepts an entity id from the client — contacts,
 * conversations, messages, glossaries, teams, channel accounts (Android device
 * revocation), and the new (H3) user-management actions. For each, Org B's authenticated
 * session attempts the action against a REAL id that genuinely exists, but belongs to
 * Org A — created directly via the org-scoped repositories, exactly as if Org B's agent
 * had guessed/scraped/replayed a real id. Every one of these must fail closed (ok:false,
 * NOT_FOUND-shaped) and must leave Org A's row completely unmodified.
 *
 * Runs against a REAL Postgres test database (see ../messaging/__tests__/testDb.ts) —
 * this class of bug (an org-scoped `where` clause silently missing its `organizationId`
 * filter) is exactly the kind of thing an in-memory mock would not catch.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";
import { configureTestDatabaseEnv } from "../messaging/__tests__/testDb";

configureTestDatabaseEnv();
process.env.ANDROID_GATEWAY_ENABLED = "true";
process.env.ANDROID_GATEWAY_SIGNING_SECRET = "test-signing-secret-do-not-use-in-prod";

vi.mock("../auth", () => ({ auth: vi.fn(async (): Promise<import("next-auth").Session | null> => null) }));

const auth = (await import("../auth")).auth as unknown as () => Promise<Session | null>;
const { prisma } = await import("../db");
const { organizationRepository } = await import("../repositories/organizationRepository");
const { userRepository } = await import("../repositories/userRepository");
const { contactRepository } = await import("../repositories/contactRepository");
const { channelAccountRepository } = await import("../repositories/channelAccountRepository");
const { contactChannelIdentityRepository } = await import("../repositories/contactChannelIdentityRepository");
const { conversationRepository } = await import("../repositories/conversationRepository");
const { teamRepository } = await import("../repositories/teamRepository");
const { glossaryRepository } = await import("../repositories/glossaryRepository");

const { setContactLanguage, updateContact, archiveContact } = await import("../actions/contacts");
const {
  assignConversation,
  changeConversationStatus,
  setConversationLanguageOverride,
  setConversationHighRisk,
  addConversationInternalNote,
} = await import("../actions/conversations");
const { sendConversationMessage, retryConversationMessage, recordTranslationEdit } = await import("../actions/messages");
const { updateGlossary, deleteGlossary } = await import("../actions/glossary");
const { updateUserRole, deactivateUser } = await import("../actions/users");
const { addTeamMember, removeTeamMember, deleteTeam } = await import("../actions/teams");
const { revokeAndroidDevice, listAndroidDevices } = await import("../actions/android");
const { channelAdapterRegistry } = await import("../channels");
const { FakeChannelAdapter } = await import("../channels/__tests__/fakeAdapter");

function fakeSession(role: Session["user"]["role"], organizationId: string, userId = "intruder"): Session {
  return { user: { id: userId, organizationId, role }, expires: "" } as Session;
}

let orgAId: string;
let orgBId: string;
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
  await prisma.organization.deleteMany({ where: { id: { in: [orgAId, orgBId].filter(Boolean) } } });
});

/** Sets up two distinct organizations, each with a full complement of its own entities. */
async function setUpTwoOrgs() {
  const orgA = await organizationRepository.create({ name: `Cross-Org Isolation — Org A ${Date.now()}-${Math.random()}` });
  const orgB = await organizationRepository.create({ name: `Cross-Org Isolation — Org B ${Date.now()}-${Math.random()}` });
  orgAId = orgA.id;
  orgBId = orgB.id;

  // Org A's own full set of entities — everything the brief calls out by name.
  const ownerA = await userRepository.create({
    organizationId: orgAId,
    name: "Org A Owner",
    email: `owner-a-${Date.now()}-${Math.random()}@test.dev`,
    role: "OWNER",
  });
  const channelAccountA = await channelAccountRepository.create(orgAId, {
    channelType: "TELEGRAM",
    displayName: "Org A Telegram Bot",
    status: "ACTIVE",
  });
  const contactA = await contactRepository.create(orgAId, { displayName: "Org A Contact", preferredLanguage: "es" });
  await contactChannelIdentityRepository.create(orgAId, {
    contactId: contactA.id,
    channelAccountId: channelAccountA.id,
    externalContactId: "org-a-external-contact",
  });
  const conversationA = await conversationRepository.upsertForContactAndChannel(orgAId, contactA.id, channelAccountA.id);
  const teamA = await teamRepository.create(orgAId, "Org A Team");
  const glossaryA = await glossaryRepository.create(orgAId, {
    name: "Org A Glossary",
    sourceLanguage: "en",
    targetLanguage: "es",
    terms: [{ term: "widget", translation: "artilugio" }],
  });

  // Org B's own session-holder, used as the attacker throughout.
  const adminB = await userRepository.create({
    organizationId: orgBId,
    name: "Org B Admin",
    email: `admin-b-${Date.now()}-${Math.random()}@test.dev`,
    role: "OWNER",
  });

  return { orgA, orgB, ownerA, channelAccountA, contactA, conversationA, teamA, glossaryA, adminB };
}

describe("Cross-org isolation — Server Actions reject a same-shaped id from a different organization", () => {
  it("setContactLanguage: Org B cannot change Org A's contact language", async () => {
    const { contactA, adminB } = await setUpTwoOrgs();
    vi.mocked(auth).mockResolvedValue(fakeSession("OWNER", orgBId, adminB.id));

    const result = await setContactLanguage({ contactId: contactA.id, preferredLanguage: "fr" });
    expect(result.ok).toBe(false);

    const unchanged = await contactRepository.findByIdInOrgOrThrow(orgAId, contactA.id);
    expect(unchanged.preferredLanguage).toBe("es"); // untouched
  });

  it("updateContact: Org B cannot edit Org A's contact", async () => {
    const { contactA, adminB } = await setUpTwoOrgs();
    vi.mocked(auth).mockResolvedValue(fakeSession("OWNER", orgBId, adminB.id));

    const result = await updateContact({ contactId: contactA.id, notes: "hijacked" });
    expect(result.ok).toBe(false);

    const unchanged = await contactRepository.findByIdInOrgOrThrow(orgAId, contactA.id);
    expect(unchanged.notes).not.toBe("hijacked");
  });

  it("archiveContact: Org B (even as Owner/Manager+) cannot archive Org A's contact", async () => {
    const { contactA, adminB } = await setUpTwoOrgs();
    vi.mocked(auth).mockResolvedValue(fakeSession("OWNER", orgBId, adminB.id));

    const result = await archiveContact({ contactId: contactA.id });
    expect(result.ok).toBe(false);

    const unchanged = await contactRepository.findByIdInOrgOrThrow(orgAId, contactA.id);
    expect(unchanged.archivedAt).toBeNull();
  });

  it("assignConversation: Org B cannot assign Org A's conversation, even to one of Org B's own users", async () => {
    const { conversationA, adminB } = await setUpTwoOrgs();
    vi.mocked(auth).mockResolvedValue(fakeSession("OWNER", orgBId, adminB.id));

    const result = await assignConversation({ conversationId: conversationA.id, assignedUserId: adminB.id });
    expect(result.ok).toBe(false);

    const unchanged = await conversationRepository.findByIdInOrgOrThrow(orgAId, conversationA.id);
    expect(unchanged.assignedUserId).toBeNull();
  });

  it("changeConversationStatus: Org B cannot change Org A's conversation status", async () => {
    const { conversationA, adminB } = await setUpTwoOrgs();
    vi.mocked(auth).mockResolvedValue(fakeSession("OWNER", orgBId, adminB.id));

    const result = await changeConversationStatus({ conversationId: conversationA.id, status: "ARCHIVED" });
    expect(result.ok).toBe(false);

    const unchanged = await conversationRepository.findByIdInOrgOrThrow(orgAId, conversationA.id);
    expect(unchanged.status).toBe("OPEN");
  });

  it("setConversationLanguageOverride: Org B cannot override Org A's conversation language", async () => {
    const { conversationA, adminB } = await setUpTwoOrgs();
    vi.mocked(auth).mockResolvedValue(fakeSession("OWNER", orgBId, adminB.id));

    const result = await setConversationLanguageOverride({ conversationId: conversationA.id, languageOverride: "de" });
    expect(result.ok).toBe(false);

    const unchanged = await conversationRepository.findByIdInOrgOrThrow(orgAId, conversationA.id);
    expect(unchanged.preferredLanguageOverride).toBeNull();
  });

  it("setConversationHighRisk: Org B cannot flag Org A's conversation as high-risk", async () => {
    const { conversationA, adminB } = await setUpTwoOrgs();
    vi.mocked(auth).mockResolvedValue(fakeSession("OWNER", orgBId, adminB.id));

    const result = await setConversationHighRisk({ conversationId: conversationA.id, highRisk: true });
    expect(result.ok).toBe(false);
  });

  it("addConversationInternalNote: Org B cannot inject an internal note into Org A's conversation", async () => {
    const { conversationA, adminB } = await setUpTwoOrgs();
    vi.mocked(auth).mockResolvedValue(fakeSession("OWNER", orgBId, adminB.id));

    const result = await addConversationInternalNote({ conversationId: conversationA.id, text: "planted note" });
    expect(result.ok).toBe(false);

    const messages = await prisma.message.findMany({ where: { conversationId: conversationA.id } });
    expect(messages).toHaveLength(0);
  });

  it("sendConversationMessage: Org B cannot send a message through Org A's conversation", async () => {
    const { conversationA, adminB } = await setUpTwoOrgs();
    vi.mocked(auth).mockResolvedValue(fakeSession("OWNER", orgBId, adminB.id));

    const result = await sendConversationMessage({ conversationId: conversationA.id, text: "hijacked send" });
    expect(result.ok).toBe(false);
    expect(adapter.sentMessages).toHaveLength(0);

    const messages = await prisma.message.findMany({ where: { conversationId: conversationA.id } });
    expect(messages).toHaveLength(0);
  });

  it("retryConversationMessage and recordTranslationEdit: Org B cannot touch a real Org A message id", async () => {
    const { conversationA, adminB } = await setUpTwoOrgs();

    // A genuine Org A message, created as Org A (so we have a real messageId to attack with).
    vi.mocked(auth).mockResolvedValue(fakeSession("OWNER", orgAId, "org-a-owner-session"));
    const sent = await sendConversationMessage({ conversationId: conversationA.id, text: "Org A's own message" });
    expect(sent.ok).toBe(true);
    if (!sent.ok) return;
    const messageId = sent.data.message.id;

    vi.mocked(auth).mockResolvedValue(fakeSession("OWNER", orgBId, adminB.id));

    const retryResult = await retryConversationMessage({ messageId });
    expect(retryResult.ok).toBe(false);

    const editResult = await recordTranslationEdit({ messageId, translatedText: "hijacked translation" });
    expect(editResult.ok).toBe(false);

    const unchanged = await prisma.message.findUniqueOrThrow({ where: { id: messageId } });
    expect(unchanged.translatedText).not.toBe("hijacked translation");
    expect(unchanged.translationEdited).toBe(false);
  });

  it("updateGlossary and deleteGlossary: Org B cannot modify or delete Org A's glossary", async () => {
    const { glossaryA, adminB } = await setUpTwoOrgs();
    vi.mocked(auth).mockResolvedValue(fakeSession("OWNER", orgBId, adminB.id));

    const updateResult = await updateGlossary({ id: glossaryA.id, name: "Hijacked Name" });
    expect(updateResult.ok).toBe(false);

    const deleteResult = await deleteGlossary({ id: glossaryA.id });
    expect(deleteResult.ok).toBe(false);

    const stillThere = await glossaryRepository.list(orgAId);
    expect(stillThere.map((g) => g.id)).toContain(glossaryA.id);
    expect(stillThere.find((g) => g.id === glossaryA.id)?.name).toBe("Org A Glossary");
  });

  it("updateUserRole and deactivateUser: Org B cannot promote/demote or deactivate Org A's Owner", async () => {
    const { ownerA, adminB } = await setUpTwoOrgs();
    vi.mocked(auth).mockResolvedValue(fakeSession("OWNER", orgBId, adminB.id));

    const roleResult = await updateUserRole({ userId: ownerA.id, role: "VIEWER" });
    expect(roleResult.ok).toBe(false);

    const deactivateResult = await deactivateUser({ userId: ownerA.id });
    expect(deactivateResult.ok).toBe(false);

    const unchanged = await userRepository.findByIdInOrgOrThrow(orgAId, ownerA.id);
    expect(unchanged.role).toBe("OWNER");
    expect(unchanged.deactivatedAt).toBeNull();
  });

  it("addTeamMember/removeTeamMember/deleteTeam: Org B cannot manage Org A's team", async () => {
    const { teamA, ownerA, adminB } = await setUpTwoOrgs();
    vi.mocked(auth).mockResolvedValue(fakeSession("OWNER", orgBId, adminB.id));

    // Even naming a real Org A user as the target member must fail — the team itself is
    // not Org B's to manage, regardless of whose userId is supplied.
    const addResult = await addTeamMember({ teamId: teamA.id, userId: ownerA.id });
    expect(addResult.ok).toBe(false);

    const removeResult = await removeTeamMember({ teamId: teamA.id, userId: ownerA.id });
    expect(removeResult.ok).toBe(false);

    const deleteResult = await deleteTeam({ teamId: teamA.id });
    expect(deleteResult.ok).toBe(false);

    const stillThere = await teamRepository.findByIdInOrg(orgAId, teamA.id);
    expect(stillThere).not.toBeNull();
  });

  it("addTeamMember: Org A cannot add an Org B user as a member of Org A's own team either (forged foreign userId)", async () => {
    const { teamA, adminB } = await setUpTwoOrgs();
    vi.mocked(auth).mockResolvedValue(fakeSession("OWNER", orgAId, "org-a-owner-session"));

    // Org A's own session, own team — but the userId supplied belongs to Org B. Must still
    // be rejected: team membership can never cross an org boundary in either direction.
    const result = await addTeamMember({ teamId: teamA.id, userId: adminB.id });
    expect(result.ok).toBe(false);
  });

  it("revokeAndroidDevice and listAndroidDevices: Org B cannot revoke or even see Org A's Android device", async () => {
    const { ownerA, adminB } = await setUpTwoOrgs();

    // Register a real Android device as Org A.
    vi.mocked(auth).mockResolvedValue(fakeSession("OWNER", orgAId, ownerA.id));
    const { registerAndroidDevice } = await import("../actions/android");
    const registered = await registerAndroidDevice({ deviceName: "Org A Phone", phoneNumber: "+15550001234" });
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;

    vi.mocked(auth).mockResolvedValue(fakeSession("OWNER", orgBId, adminB.id));

    const listResult = await listAndroidDevices();
    expect(listResult.ok).toBe(true);
    if (listResult.ok) {
      expect(listResult.data.map((d) => d.id)).not.toContain(registered.data.deviceId);
    }

    const revokeResult = await revokeAndroidDevice({ deviceId: registered.data.deviceId });
    expect(revokeResult.ok).toBe(false);

    const stillActive = await channelAccountRepository.findByIdInOrgOrThrow(orgAId, registered.data.deviceId);
    expect(stillActive.revokedAt).toBeNull();
  });
});
