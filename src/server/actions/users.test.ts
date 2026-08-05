/**
 * Tests for the user-management Server Actions (H3 fix, docs/review-report.md):
 * `listUsers`, `inviteUser`, `updateUserRole`, `deactivateUser`. Runs against a REAL
 * Postgres test database (see ../messaging/__tests__/testDb.ts); `../auth`'s `auth()` is
 * mocked.
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
const { verifyCredentials } = await import("../credentialsAuth");
const { listUsers, inviteUser, updateUserRole, deactivateUser } = await import("./users");

function fakeSession(role: Session["user"]["role"], organizationId: string, userId: string): Session {
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

async function setUpOrgWithOwner() {
  const organization = await organizationRepository.create({ name: `Users Action Test Org ${Date.now()}-${Math.random()}` });
  organizationId = organization.id;
  const owner = await userRepository.create({
    organizationId,
    name: "Org Owner",
    email: `owner-${Date.now()}-${Math.random()}@test.dev`,
    role: "OWNER",
  });
  return { organization, owner };
}

describe("listUsers", () => {
  it("rejects a session below Administrator", async () => {
    const { organization } = await setUpOrgWithOwner();
    vi.mocked(auth).mockResolvedValue(fakeSession("AGENT", organization.id, "irrelevant"));
    const result = await listUsers();
    expect(result.ok).toBe(false);
  });

  it("lists every user in the org for an Administrator+ session", async () => {
    const { organization, owner } = await setUpOrgWithOwner();
    vi.mocked(auth).mockResolvedValue(fakeSession("OWNER", organization.id, owner.id));
    const result = await listUsers();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.map((u) => u.id)).toContain(owner.id);
  });
});

describe("inviteUser", () => {
  it("rejects a session below Administrator", async () => {
    const { organization } = await setUpOrgWithOwner();
    vi.mocked(auth).mockResolvedValue(fakeSession("AGENT", organization.id, "irrelevant"));
    const result = await inviteUser({ name: "New Agent", email: "new-agent@test.dev", role: "AGENT" });
    expect(result.ok).toBe(false);
  });

  it("creates a user, returns a one-time temporary password, and writes an AuditLog row", async () => {
    const { organization, owner } = await setUpOrgWithOwner();
    vi.mocked(auth).mockResolvedValue(fakeSession("OWNER", organization.id, owner.id));

    const email = `invitee-${Date.now()}-${Math.random()}@test.dev`;
    const result = await inviteUser({ name: "New Agent", email, role: "AGENT" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.user.email).toBe(email);
    expect(result.data.user.role).toBe("AGENT");
    expect(result.data.temporaryPassword.length).toBeGreaterThan(8);

    // The temp password actually works for sign-in.
    const signedIn = await verifyCredentials(
      { email, password: result.data.temporaryPassword },
      new Request("https://example.com", { headers: { "X-Forwarded-For": "192.0.2.1" } }),
    );
    expect(signedIn?.id).toBe(result.data.user.id);

    const auditRows = await prisma.auditLog.findMany({ where: { organizationId: organization.id, action: "user.invited" } });
    expect(auditRows).toHaveLength(1);
  });

  it("rejects inviting a user with a role higher than the inviter's own (privilege escalation guard)", async () => {
    const { organization } = await setUpOrgWithOwner();
    const admin = await userRepository.create({
      organizationId: organization.id,
      name: "Org Admin",
      email: `admin-${Date.now()}-${Math.random()}@test.dev`,
      role: "ADMINISTRATOR",
    });
    vi.mocked(auth).mockResolvedValue(fakeSession("ADMINISTRATOR", organization.id, admin.id));

    const result = await inviteUser({ name: "Wannabe Owner", email: "wannabe-owner@test.dev", role: "OWNER" });
    expect(result.ok).toBe(false);
  });

  it("rejects inviting the same email twice in the same org with a conflict", async () => {
    const { organization, owner } = await setUpOrgWithOwner();
    vi.mocked(auth).mockResolvedValue(fakeSession("OWNER", organization.id, owner.id));
    const email = `dup-invite-${Date.now()}-${Math.random()}@test.dev`;

    const first = await inviteUser({ name: "First", email, role: "AGENT" });
    expect(first.ok).toBe(true);
    const second = await inviteUser({ name: "Second", email, role: "AGENT" });
    expect(second.ok).toBe(false);
  });
});

describe("updateUserRole", () => {
  it("rejects a session below Administrator", async () => {
    const { organization, owner } = await setUpOrgWithOwner();
    vi.mocked(auth).mockResolvedValue(fakeSession("AGENT", organization.id, "irrelevant"));
    const result = await updateUserRole({ userId: owner.id, role: "MANAGER" });
    expect(result.ok).toBe(false);
  });

  it("changes a non-Owner user's role and writes an AuditLog row", async () => {
    const { organization, owner } = await setUpOrgWithOwner();
    const agent = await userRepository.create({
      organizationId: organization.id,
      name: "Some Agent",
      email: `agent-${Date.now()}-${Math.random()}@test.dev`,
      role: "AGENT",
    });
    vi.mocked(auth).mockResolvedValue(fakeSession("OWNER", organization.id, owner.id));

    const result = await updateUserRole({ userId: agent.id, role: "MANAGER" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.role).toBe("MANAGER");

    const auditRows = await prisma.auditLog.findMany({ where: { organizationId: organization.id, action: "user.role_changed" } });
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].metadata).toMatchObject({ fromRole: "AGENT", toRole: "MANAGER" });
  });

  it("H3: cannot demote the last Owner to a lower role", async () => {
    const { organization, owner } = await setUpOrgWithOwner();
    vi.mocked(auth).mockResolvedValue(fakeSession("OWNER", organization.id, owner.id));

    const result = await updateUserRole({ userId: owner.id, role: "ADMINISTRATOR" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/last owner/i);

    const stillOwner = await userRepository.findByIdInOrgOrThrow(organization.id, owner.id);
    expect(stillOwner.role).toBe("OWNER");
  });

  it("allows demoting an Owner when another active Owner exists", async () => {
    const { organization, owner } = await setUpOrgWithOwner();
    const secondOwner = await userRepository.create({
      organizationId: organization.id,
      name: "Second Owner",
      email: `owner2-${Date.now()}-${Math.random()}@test.dev`,
      role: "OWNER",
    });
    vi.mocked(auth).mockResolvedValue(fakeSession("OWNER", organization.id, owner.id));

    const result = await updateUserRole({ userId: secondOwner.id, role: "ADMINISTRATOR" });
    expect(result.ok).toBe(true);
  });

  it("rejects granting a role higher than the acting Administrator's own role", async () => {
    const { organization } = await setUpOrgWithOwner();
    const admin = await userRepository.create({
      organizationId: organization.id,
      name: "Org Admin",
      email: `admin2-${Date.now()}-${Math.random()}@test.dev`,
      role: "ADMINISTRATOR",
    });
    const agent = await userRepository.create({
      organizationId: organization.id,
      name: "Some Agent",
      email: `agent2-${Date.now()}-${Math.random()}@test.dev`,
      role: "AGENT",
    });
    vi.mocked(auth).mockResolvedValue(fakeSession("ADMINISTRATOR", organization.id, admin.id));

    const result = await updateUserRole({ userId: agent.id, role: "OWNER" });
    expect(result.ok).toBe(false);
  });
});

describe("deactivateUser", () => {
  it("rejects a session below Administrator", async () => {
    const { organization, owner } = await setUpOrgWithOwner();
    vi.mocked(auth).mockResolvedValue(fakeSession("AGENT", organization.id, "irrelevant"));
    const result = await deactivateUser({ userId: owner.id });
    expect(result.ok).toBe(false);
  });

  it("deactivates a non-Owner user, blocks their sign-in, and writes an AuditLog row", async () => {
    const { organization, owner } = await setUpOrgWithOwner();
    const email = `deactivate-me-${Date.now()}-${Math.random()}@test.dev`;
    vi.mocked(auth).mockResolvedValue(fakeSession("OWNER", organization.id, owner.id));
    const invited = await inviteUser({ name: "Deactivate Me", email, role: "AGENT" });
    expect(invited.ok).toBe(true);
    if (!invited.ok) return;

    const result = await deactivateUser({ userId: invited.data.user.id });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.deactivatedAt).not.toBeNull();

    const signInAttempt = await verifyCredentials(
      { email, password: invited.data.temporaryPassword },
      new Request("https://example.com", { headers: { "X-Forwarded-For": "192.0.2.2" } }),
    );
    expect(signInAttempt).toBeNull();

    const auditRows = await prisma.auditLog.findMany({ where: { organizationId: organization.id, action: "user.deactivated" } });
    expect(auditRows).toHaveLength(1);
  });

  it("H3: cannot deactivate the last Owner", async () => {
    const { organization, owner } = await setUpOrgWithOwner();
    vi.mocked(auth).mockResolvedValue(fakeSession("OWNER", organization.id, owner.id));

    const result = await deactivateUser({ userId: owner.id });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/last owner/i);

    const stillActive = await userRepository.findByIdInOrgOrThrow(organization.id, owner.id);
    expect(stillActive.deactivatedAt).toBeNull();
  });

  it("allows deactivating an Owner when another active Owner exists", async () => {
    const { organization, owner } = await setUpOrgWithOwner();
    const secondOwner = await userRepository.create({
      organizationId: organization.id,
      name: "Second Owner",
      email: `owner3-${Date.now()}-${Math.random()}@test.dev`,
      role: "OWNER",
    });
    vi.mocked(auth).mockResolvedValue(fakeSession("OWNER", organization.id, owner.id));

    const result = await deactivateUser({ userId: secondOwner.id });
    expect(result.ok).toBe(true);
  });
});
