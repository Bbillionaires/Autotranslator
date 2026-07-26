/**
 * Tests for the Team-management Server Actions (`createTeam`/`deleteTeam`/
 * `addTeamMember`/`removeTeamMember`), per docs/implementation-plan.md §5: "Session+Role
 * (Manager+) for membership, Role(Administrator+) for create/delete." Runs against a REAL
 * Postgres test database (see ../messaging/__tests__/testDb.ts).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";
import { configureTestDatabaseEnv } from "../messaging/__tests__/testDb";

configureTestDatabaseEnv();

vi.mock("../auth", () => ({ auth: vi.fn(async (): Promise<import("next-auth").Session | null> => null) }));

const auth = (await import("../auth")).auth as unknown as () => Promise<Session | null>;
const { prisma } = await import("../db");
const { organizationRepository } = await import("../repositories/organizationRepository");
const { teamRepository } = await import("../repositories/teamRepository");
const { userRepository } = await import("../repositories/userRepository");
const { createTeam, deleteTeam, addTeamMember, removeTeamMember } = await import("./teams");

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

async function setUpOrgAndUser() {
  const organization = await organizationRepository.create({ name: `Teams Action Test Org ${Date.now()}-${Math.random()}` });
  organizationId = organization.id;
  const user = await userRepository.create({ organizationId, name: "Alex Agent", email: `alex-${Date.now()}@test.dev`, role: "AGENT" });
  return { user };
}

describe("createTeam", () => {
  it("rejects a session below Administrator (e.g. Manager)", async () => {
    await setUpOrgAndUser();
    vi.mocked(auth).mockResolvedValue(fakeSession("MANAGER", organizationId));

    const result = await createTeam({ name: "New Team" });
    expect(result.ok).toBe(false);
  });

  it("creates a team for an Administrator+ session and writes an AuditLog row", async () => {
    const { user } = await setUpOrgAndUser();
    vi.mocked(auth).mockResolvedValue(fakeSession("ADMINISTRATOR", organizationId, user.id));

    const result = await createTeam({ name: "New Team" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.name).toBe("New Team");

    const auditRows = await prisma.auditLog.findMany({ where: { organizationId, action: "team.created" } });
    expect(auditRows).toHaveLength(1);
  });
});

describe("deleteTeam", () => {
  it("rejects a session below Administrator (e.g. Manager)", async () => {
    await setUpOrgAndUser();
    const team = await teamRepository.create(organizationId, "Doomed Team");
    vi.mocked(auth).mockResolvedValue(fakeSession("MANAGER", organizationId));

    const result = await deleteTeam({ teamId: team.id });
    expect(result.ok).toBe(false);

    const stillExists = await teamRepository.findByIdInOrg(organizationId, team.id);
    expect(stillExists).not.toBeNull();
  });

  it("deletes the team for an Administrator+ session", async () => {
    const { user } = await setUpOrgAndUser();
    const team = await teamRepository.create(organizationId, "Doomed Team");
    vi.mocked(auth).mockResolvedValue(fakeSession("ADMINISTRATOR", organizationId, user.id));

    const result = await deleteTeam({ teamId: team.id });
    expect(result.ok).toBe(true);

    const gone = await teamRepository.findByIdInOrg(organizationId, team.id);
    expect(gone).toBeNull();
  });
});

describe("addTeamMember", () => {
  it("rejects a session below Manager (e.g. Agent)", async () => {
    const { user } = await setUpOrgAndUser();
    const team = await teamRepository.create(organizationId, "Support");
    vi.mocked(auth).mockResolvedValue(fakeSession("AGENT", organizationId));

    const result = await addTeamMember({ teamId: team.id, userId: user.id });
    expect(result.ok).toBe(false);
  });

  it("adds a member for a Manager+ session and writes an AuditLog row", async () => {
    const { user } = await setUpOrgAndUser();
    const actingManager = await userRepository.create({
      organizationId,
      name: "Acting Manager",
      email: `acting-manager-${Date.now()}-${Math.random()}@test.dev`,
      role: "MANAGER",
    });
    const team = await teamRepository.create(organizationId, "Support");
    vi.mocked(auth).mockResolvedValue(fakeSession("MANAGER", organizationId, actingManager.id));

    const result = await addTeamMember({ teamId: team.id, userId: user.id });
    expect(result.ok).toBe(true);

    const withMembers = await teamRepository.findByIdWithMembers(organizationId, team.id);
    expect(withMembers.members).toHaveLength(1);

    const auditRows = await prisma.auditLog.findMany({ where: { organizationId, action: "team.member_added" } });
    expect(auditRows).toHaveLength(1);
  });
});

describe("removeTeamMember", () => {
  it("rejects a session below Manager (e.g. Agent)", async () => {
    const { user } = await setUpOrgAndUser();
    const team = await teamRepository.create(organizationId, "Support");
    await teamRepository.addMember(organizationId, team.id, user.id);
    vi.mocked(auth).mockResolvedValue(fakeSession("AGENT", organizationId));

    const result = await removeTeamMember({ teamId: team.id, userId: user.id });
    expect(result.ok).toBe(false);
  });

  it("removes a member for a Manager+ session", async () => {
    const { user } = await setUpOrgAndUser();
    const actingManager = await userRepository.create({
      organizationId,
      name: "Acting Manager",
      email: `acting-manager-${Date.now()}-${Math.random()}@test.dev`,
      role: "MANAGER",
    });
    const team = await teamRepository.create(organizationId, "Support");
    await teamRepository.addMember(organizationId, team.id, user.id);
    vi.mocked(auth).mockResolvedValue(fakeSession("MANAGER", organizationId, actingManager.id));

    const result = await removeTeamMember({ teamId: team.id, userId: user.id });
    expect(result.ok).toBe(true);

    const withMembers = await teamRepository.findByIdWithMembers(organizationId, team.id);
    expect(withMembers.members).toHaveLength(0);
  });
});
