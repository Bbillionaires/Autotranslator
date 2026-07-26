/**
 * Tests for the glossary CRUD Server Actions (`listGlossaries`/`createGlossary`/
 * `updateGlossary`/`deleteGlossary`), per docs/implementation-plan.md §5 ("Session+Role
 * (Manager+) | Zod validates `terms` array shape"). `glossaryRepository` itself already has
 * its own repository-level tests (../repositories/glossaryRepository.test.ts) — these cover
 * the Server Action layer's role-gating + audit-logging on top of it.
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
const { listGlossaries, createGlossary, updateGlossary, deleteGlossary } = await import("./glossary");

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
  const organization = await organizationRepository.create({ name: `Glossary Action Test Org ${Date.now()}-${Math.random()}` });
  organizationId = organization.id;
  const actingManager = await userRepository.create({
    organizationId,
    name: "Acting Manager",
    email: `acting-manager-${Date.now()}-${Math.random()}@test.dev`,
    role: "MANAGER",
  });
  return { actingManager };
}

const sampleInput = {
  name: "Test glossary",
  sourceLanguage: "es",
  targetLanguage: "en",
  terms: [{ term: "pedido", translation: "order" }],
};

describe("createGlossary", () => {
  it("rejects a session below Manager (e.g. Agent)", async () => {
    await setUpOrg();
    vi.mocked(auth).mockResolvedValue(fakeSession("AGENT", organizationId));

    const result = await createGlossary(sampleInput);
    expect(result.ok).toBe(false);
  });

  it("creates a glossary for a Manager+ session and writes an AuditLog row", async () => {
    const { actingManager } = await setUpOrg();
    vi.mocked(auth).mockResolvedValue(fakeSession("MANAGER", organizationId, actingManager.id));

    const result = await createGlossary(sampleInput);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.name).toBe("Test glossary");

    const auditRows = await prisma.auditLog.findMany({ where: { organizationId, action: "glossary.created" } });
    expect(auditRows).toHaveLength(1);
  });
});

describe("listGlossaries", () => {
  it("rejects a session below Manager (e.g. Agent)", async () => {
    await setUpOrg();
    vi.mocked(auth).mockResolvedValue(fakeSession("AGENT", organizationId));

    const result = await listGlossaries();
    expect(result.ok).toBe(false);
  });
});

describe("updateGlossary", () => {
  it("rejects a session below Manager (e.g. Agent)", async () => {
    const { actingManager } = await setUpOrg();
    vi.mocked(auth).mockResolvedValue(fakeSession("MANAGER", organizationId, actingManager.id));
    const created = await createGlossary(sampleInput);
    if (!created.ok) throw new Error("setup failed");

    vi.mocked(auth).mockResolvedValue(fakeSession("AGENT", organizationId));
    const result = await updateGlossary({ id: created.data.id, name: "Renamed" });
    expect(result.ok).toBe(false);
  });

  it("updates for a Manager+ session", async () => {
    const { actingManager } = await setUpOrg();
    vi.mocked(auth).mockResolvedValue(fakeSession("MANAGER", organizationId, actingManager.id));
    const created = await createGlossary(sampleInput);
    if (!created.ok) throw new Error("setup failed");

    const result = await updateGlossary({ id: created.data.id, name: "Renamed" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.name).toBe("Renamed");
  });
});

describe("deleteGlossary", () => {
  it("rejects a session below Manager (e.g. Agent)", async () => {
    const { actingManager } = await setUpOrg();
    vi.mocked(auth).mockResolvedValue(fakeSession("MANAGER", organizationId, actingManager.id));
    const created = await createGlossary(sampleInput);
    if (!created.ok) throw new Error("setup failed");

    vi.mocked(auth).mockResolvedValue(fakeSession("AGENT", organizationId));
    const result = await deleteGlossary({ id: created.data.id });
    expect(result.ok).toBe(false);
  });

  it("deletes for a Manager+ session", async () => {
    const { actingManager } = await setUpOrg();
    vi.mocked(auth).mockResolvedValue(fakeSession("MANAGER", organizationId, actingManager.id));
    const created = await createGlossary(sampleInput);
    if (!created.ok) throw new Error("setup failed");

    const result = await deleteGlossary({ id: created.data.id });
    expect(result.ok).toBe(true);

    const list = await listGlossaries();
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    expect(list.data).toHaveLength(0);
  });
});
