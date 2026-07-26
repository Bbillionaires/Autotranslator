/**
 * Tests for `resolveOrCreateContactAndConversation`, per docs/implementation-plan.md §3.5
 * step 5. Runs against a REAL Postgres test database (same pattern as
 * inboundService.test.ts/outboundService.test.ts — see ./__tests__/testDb.ts) since the
 * H5 race-condition fix specifically depends on Postgres's real unique-constraint/
 * transaction-rollback behavior under genuine concurrent requests, which an in-memory mock
 * cannot exercise meaningfully.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { configureTestDatabaseEnv } from "./__tests__/testDb";

configureTestDatabaseEnv();

const { prisma } = await import("../db");
const { organizationRepository } = await import("../repositories/organizationRepository");
const { channelAccountRepository } = await import("../repositories/channelAccountRepository");
const { contactChannelIdentityRepository } = await import("../repositories/contactChannelIdentityRepository");
const { resolveOrCreateContactAndConversation } = await import("./contactResolution");

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

async function setUpOrgAndChannel() {
  const organization = await organizationRepository.create({ name: `Contact Resolution Test Org ${Date.now()}-${Math.random()}` });
  organizationId = organization.id;
  const channelAccount = await channelAccountRepository.create(organizationId, {
    channelType: "TELEGRAM",
    displayName: "Test Bot",
    status: "ACTIVE",
  });
  return { channelAccount };
}

describe("resolveOrCreateContactAndConversation", () => {
  it("creates a new Contact + ContactChannelIdentity + Conversation on first contact", async () => {
    const { channelAccount } = await setUpOrgAndChannel();

    const { contact, conversation } = await resolveOrCreateContactAndConversation(organizationId, channelAccount, {
      externalContactId: "ext-1",
      externalUsername: "alice",
    });

    expect(contact.displayName).toBe("alice");
    expect(conversation.contactId).toBe(contact.id);
    expect(conversation.channelAccountId).toBe(channelAccount.id);

    const identity = await contactChannelIdentityRepository.findByChannelAndExternalId(organizationId, channelAccount.id, "ext-1");
    expect(identity?.contactId).toBe(contact.id);
  });

  it("resolves to the existing Contact on a second call for the same externalContactId (no duplicate created)", async () => {
    const { channelAccount } = await setUpOrgAndChannel();

    const firstCall = await resolveOrCreateContactAndConversation(organizationId, channelAccount, {
      externalContactId: "ext-2",
      externalUsername: "bob",
    });
    const secondCall = await resolveOrCreateContactAndConversation(organizationId, channelAccount, {
      externalContactId: "ext-2",
      externalUsername: "bob",
    });

    expect(secondCall.contact.id).toBe(firstCall.contact.id);
    expect(secondCall.conversation.id).toBe(firstCall.conversation.id);

    const contactCount = await prisma.contact.count({ where: { organizationId } });
    expect(contactCount).toBe(1);
  });

  it("H5: two near-simultaneous calls for the same brand-new externalContactId race safely — no unhandled error, exactly one Contact/Identity created", async () => {
    const { channelAccount } = await setUpOrgAndChannel();

    // Fire both calls concurrently (real Promise.all interleaving against a real Postgres
    // connection pool) for the exact same never-before-seen externalContactId — this is the
    // "two near-simultaneous first messages"/"aggressive webhook retry" scenario H5
    // describes. Before the fix, the loser's ContactChannelIdentity insert threw an
    // uncaught P2002 instead of resolving gracefully.
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        resolveOrCreateContactAndConversation(organizationId, channelAccount, {
          externalContactId: "ext-race",
          externalUsername: "carol",
        }),
      ),
    );

    // Every call must succeed (no throw propagated out of Promise.all) and every call must
    // resolve to the SAME Contact and the SAME Conversation.
    const contactIds = new Set(results.map((r) => r.contact.id));
    const conversationIds = new Set(results.map((r) => r.conversation.id));
    expect(contactIds.size).toBe(1);
    expect(conversationIds.size).toBe(1);

    const contactCount = await prisma.contact.count({ where: { organizationId } });
    expect(contactCount).toBe(1);

    const identityCount = await prisma.contactChannelIdentity.count({
      where: { channelAccountId: channelAccount.id, externalContactId: "ext-race" },
    });
    expect(identityCount).toBe(1);

    const conversationCount = await prisma.conversation.count({ where: { organizationId } });
    expect(conversationCount).toBe(1);
  });
});
