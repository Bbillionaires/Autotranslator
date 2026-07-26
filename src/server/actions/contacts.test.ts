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
const { setContactLanguage } = await import("./contacts");

function fakeSession(role: Session["user"]["role"], organizationId: string): Session {
  return { user: { id: "u1", organizationId, role }, expires: "" } as Session;
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
