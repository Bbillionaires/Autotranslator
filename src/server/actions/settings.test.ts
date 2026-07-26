/**
 * Tests for the org settings Server Actions (`getOrgSettings`/`updateOrgSettings`), per
 * docs/implementation-plan.md §5 ("Session+Role(Administrator+) | audit-logged").
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";
import { configureTestDatabaseEnv } from "../messaging/__tests__/testDb";

configureTestDatabaseEnv();

vi.mock("../auth", () => ({ auth: vi.fn(async (): Promise<import("next-auth").Session | null> => null) }));

const auth = (await import("../auth")).auth as unknown as () => Promise<Session | null>;
const { prisma } = await import("../db");
const { organizationRepository } = await import("../repositories/organizationRepository");
const { userRepository } = await import("../repositories/userRepository");
const { getOrgSettings, updateOrgSettings } = await import("./settings");

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

async function setUpOrg() {
  const organization = await organizationRepository.create({ name: `Settings Action Test Org ${Date.now()}-${Math.random()}` });
  organizationId = organization.id;
  const actingAdmin = await userRepository.create({
    organizationId,
    name: "Acting Admin",
    email: `acting-admin-${Date.now()}-${Math.random()}@test.dev`,
    role: "ADMINISTRATOR",
  });
  return { organization, actingAdmin };
}

describe("getOrgSettings", () => {
  it("rejects a session below Administrator (e.g. Manager)", async () => {
    await setUpOrg();
    vi.mocked(auth).mockResolvedValue(fakeSession("MANAGER", organizationId));

    const result = await getOrgSettings();
    expect(result.ok).toBe(false);
  });

  it("returns settings including the env-driven translation provider for an Administrator+ session", async () => {
    const { actingAdmin } = await setUpOrg();
    vi.mocked(auth).mockResolvedValue(fakeSession("ADMINISTRATOR", organizationId, actingAdmin.id));

    const result = await getOrgSettings();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.translationProvider).toBe("noop");
  });
});

describe("updateOrgSettings", () => {
  it("rejects a session below Administrator (e.g. Manager)", async () => {
    await setUpOrg();
    vi.mocked(auth).mockResolvedValue(fakeSession("MANAGER", organizationId));

    const result = await updateOrgSettings({ defaultLanguage: "fr" });
    expect(result.ok).toBe(false);
  });

  it("updates settings for an Administrator+ session and writes an AuditLog row", async () => {
    const { actingAdmin } = await setUpOrg();
    vi.mocked(auth).mockResolvedValue(fakeSession("ADMINISTRATOR", organizationId, actingAdmin.id));

    const result = await updateOrgSettings({ defaultLanguage: "fr", reviewBeforeSendDefault: true, dataRetentionDays: 90 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.defaultLanguage).toBe("fr");
    expect(result.data.reviewBeforeSendDefault).toBe(true);
    expect(result.data.dataRetentionDays).toBe(90);

    const auditRows = await prisma.auditLog.findMany({ where: { organizationId, action: "organization.settings_updated" } });
    expect(auditRows).toHaveLength(1);
  });

  it("allows clearing dataRetentionDays back to null (keep forever)", async () => {
    const { actingAdmin } = await setUpOrg();
    vi.mocked(auth).mockResolvedValue(fakeSession("ADMINISTRATOR", organizationId, actingAdmin.id));

    await updateOrgSettings({ dataRetentionDays: 30 });
    const result = await updateOrgSettings({ dataRetentionDays: null });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.dataRetentionDays).toBeNull();
  });
});
