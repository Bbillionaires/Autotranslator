/**
 * Tests for the `setContactLanguage` Server Action, per docs/implementation-plan.md §5
 * ("Server Action `setContactLanguage` | Set `preferredLanguage` explicitly |
 * Session+Role(Agent+) | Zod BCP-47 language code validator"). Runs against a REAL Postgres
 * test database (see ../messaging/__tests__/testDb.ts) since it exercises the real
 * `contactRepository.updatePreferredLanguage` write; `../auth`'s `auth()` is mocked.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";
import { configureTestDatabaseEnv } from "../messaging/__tests__/testDb";

configureTestDatabaseEnv();

vi.mock("../auth", () => ({ auth: vi.fn(async (): Promise<import("next-auth").Session | null> => null) }));

// `auth` from `next-auth` is overloaded (a bare call vs. a middleware-wrapping call), which
// confuses `vi.mocked(...)`'s overload resolution for `.mockResolvedValue(...)`. Cast to the
// single signature this app actually uses (`() => Promise<Session | null>`) so the mock
// helper types resolve correctly.
const auth = (await import("../auth")).auth as unknown as () => Promise<Session | null>;
const { prisma } = await import("../db");
const { organizationRepository } = await import("../repositories/organizationRepository");
const { contactRepository } = await import("../repositories/contactRepository");
const { userRepository } = await import("../repositories/userRepository");
const { setContactLanguage, createContact, updateContact, archiveContact } = await import("./contacts");

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

async function setUpOrgAndContact() {
  const organization = await organizationRepository.create({ name: `SetContactLanguage Test Org ${Date.now()}-${Math.random()}` });
  organizationId = organization.id;
  const contact = await contactRepository.create(organizationId, { displayName: "Test Contact" });
  return { organization, contact };
}

describe("setContactLanguage", () => {
  it("rejects a session below Agent (e.g. Viewer)", async () => {
    const { contact } = await setUpOrgAndContact();
    vi.mocked(auth).mockResolvedValue(fakeSession("VIEWER", organizationId));

    const result = await setContactLanguage({ contactId: contact.id, preferredLanguage: "es" });
    expect(result.ok).toBe(false);

    const unchanged = await contactRepository.findByIdInOrgOrThrow(organizationId, contact.id);
    expect(unchanged.preferredLanguage).toBeNull();
  });

  it("sets Contact.preferredLanguage for an Agent+ session", async () => {
    const { contact } = await setUpOrgAndContact();
    vi.mocked(auth).mockResolvedValue(fakeSession("AGENT", organizationId));

    const result = await setContactLanguage({ contactId: contact.id, preferredLanguage: "fr" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.preferredLanguage).toBe("fr");

    const stored = await contactRepository.findByIdInOrgOrThrow(organizationId, contact.id);
    expect(stored.preferredLanguage).toBe("fr");
  });

  it("rejects an invalid (empty) language code via the Zod schema", async () => {
    const { contact } = await setUpOrgAndContact();
    vi.mocked(auth).mockResolvedValue(fakeSession("AGENT", organizationId));

    const result = await setContactLanguage({ contactId: contact.id, preferredLanguage: "" });
    expect(result.ok).toBe(false);
  });

  it("cannot set the preferred language of a contact in a different organization", async () => {
    const { contact } = await setUpOrgAndContact();
    const otherOrg = await organizationRepository.create({ name: `Other Org ${Date.now()}-${Math.random()}` });
    vi.mocked(auth).mockResolvedValue(fakeSession("AGENT", otherOrg.id));

    const result = await setContactLanguage({ contactId: contact.id, preferredLanguage: "de" });
    expect(result.ok).toBe(false);

    await prisma.organization.deleteMany({ where: { id: otherOrg.id } });
  });
});

describe("createContact", () => {
  it("rejects a session below Agent (e.g. Viewer)", async () => {
    const organization = await organizationRepository.create({ name: `CreateContact Test Org ${Date.now()}-${Math.random()}` });
    organizationId = organization.id;
    vi.mocked(auth).mockResolvedValue(fakeSession("VIEWER", organizationId));

    const result = await createContact({ displayName: "New Contact" });
    expect(result.ok).toBe(false);
  });

  it("creates a contact for an Agent+ session", async () => {
    const organization = await organizationRepository.create({ name: `CreateContact Test Org ${Date.now()}-${Math.random()}` });
    organizationId = organization.id;
    vi.mocked(auth).mockResolvedValue(fakeSession("AGENT", organizationId));

    const result = await createContact({ displayName: "New Contact", preferredLanguage: "fr" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.displayName).toBe("New Contact");
    expect(result.data.preferredLanguage).toBe("fr");
  });

  it("rejects an empty displayName via the Zod schema", async () => {
    const organization = await organizationRepository.create({ name: `CreateContact Test Org ${Date.now()}-${Math.random()}` });
    organizationId = organization.id;
    vi.mocked(auth).mockResolvedValue(fakeSession("AGENT", organizationId));

    const result = await createContact({ displayName: "" });
    expect(result.ok).toBe(false);
  });
});

describe("updateContact", () => {
  it("rejects a session below Agent (e.g. Viewer)", async () => {
    const { contact } = await setUpOrgAndContact();
    vi.mocked(auth).mockResolvedValue(fakeSession("VIEWER", organizationId));

    const result = await updateContact({ contactId: contact.id, notes: "Should not be saved" });
    expect(result.ok).toBe(false);
  });

  it("updates fields for an Agent+ session", async () => {
    const { contact } = await setUpOrgAndContact();
    vi.mocked(auth).mockResolvedValue(fakeSession("AGENT", organizationId));

    const result = await updateContact({ contactId: contact.id, notes: "Called back, resolved." });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.notes).toBe("Called back, resolved.");
  });
});

describe("archiveContact", () => {
  it("rejects a session below Manager (e.g. Agent)", async () => {
    const { contact } = await setUpOrgAndContact();
    vi.mocked(auth).mockResolvedValue(fakeSession("AGENT", organizationId));

    const result = await archiveContact({ contactId: contact.id });
    expect(result.ok).toBe(false);

    const unchanged = await contactRepository.findByIdInOrgOrThrow(organizationId, contact.id);
    expect(unchanged.archivedAt).toBeNull();
  });

  it("archives the contact for a Manager+ session and writes an AuditLog row", async () => {
    const { contact } = await setUpOrgAndContact();
    const actingUser = await userRepository.create({
      organizationId,
      name: "Acting Manager",
      email: `acting-manager-${Date.now()}-${Math.random()}@test.dev`,
      role: "MANAGER",
    });
    vi.mocked(auth).mockResolvedValue(fakeSession("MANAGER", organizationId, actingUser.id));

    const result = await archiveContact({ contactId: contact.id });
    expect(result.ok).toBe(true);

    const archived = await contactRepository.findByIdInOrgOrThrow(organizationId, contact.id);
    expect(archived.archivedAt).not.toBeNull();

    const auditRows = await prisma.auditLog.findMany({ where: { organizationId, entityType: "Contact", entityId: contact.id } });
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].action).toBe("contact.archived");
  });
});
