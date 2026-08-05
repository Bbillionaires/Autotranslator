/**
 * Integration tests for NEW-2's fix (docs/review-report.md "Final Review"):
 * `refreshSessionTokenClaims` — the DB re-check `auth.ts`'s `jwt` callback now runs on its
 * refresh path. Runs against a REAL Postgres test database (see
 * ../messaging/__tests__/testDb.ts), same convention as `actions/users.test.ts`.
 *
 * Crucially, these tests don't just assert on an isolated DB write — they drive the DB
 * change through the actual `deactivateUser`/`updateUserRole` Server Actions (the real H3
 * production code path an Administrator would trigger), then feed a session token built
 * BEFORE that change into `refreshSessionTokenClaims` (the real session-refresh code `jwt`
 * calls) to prove the *next refresh* of an already-existing session reflects it — either by
 * dying (deactivation) or by `requireRole` seeing the updated role (demotion/promotion).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";
import type { SessionTokenClaims } from "./authTokenRefresh";
import { configureTestDatabaseEnv } from "./messaging/__tests__/testDb";

configureTestDatabaseEnv();

vi.mock("./auth", () => ({ auth: vi.fn(async (): Promise<import("next-auth").Session | null> => null) }));

const auth = (await import("./auth")).auth as unknown as () => Promise<Session | null>;
const { prisma } = await import("./db");
const { organizationRepository } = await import("./repositories/organizationRepository");
const { userRepository } = await import("./repositories/userRepository");
const { deactivateUser, updateUserRole } = await import("./actions/users");
const { refreshSessionTokenClaims } = await import("./authTokenRefresh");
const { requireRole } = await import("./roles");
const { ForbiddenError } = await import("./errors");

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

async function setUpOrgWithOwnerAndTarget(targetRole: "AGENT" | "ADMINISTRATOR" = "AGENT") {
  const organization = await organizationRepository.create({ name: `Token Refresh Test Org ${Date.now()}-${Math.random()}` });
  organizationId = organization.id;
  const owner = await userRepository.create({
    organizationId,
    name: "Org Owner",
    email: `owner-${Date.now()}-${Math.random()}@test.dev`,
    role: "OWNER",
  });
  const target = await userRepository.create({
    organizationId,
    name: "Target User",
    email: `target-${Date.now()}-${Math.random()}@test.dev`,
    role: targetRole,
  });
  return { organization, owner, target };
}

describe("refreshSessionTokenClaims — the jwt callback's DB re-check (NEW-2 fix)", () => {
  it("leaves an active, unchanged user's token as-is", async () => {
    const { target } = await setUpOrgWithOwnerAndTarget("AGENT");
    const token: SessionTokenClaims = { userId: target.id, organizationId, role: "AGENT" };

    const refreshed = await refreshSessionTokenClaims(token);

    expect(refreshed).not.toBeNull();
    expect(refreshed?.role).toBe("AGENT");
    expect(refreshed?.organizationId).toBe(organizationId);
  });

  it(
    "a session token issued BEFORE a real deactivateUser() call is invalidated (returns null) on its next refresh — the session dies",
    async () => {
      const { organization, owner, target } = await setUpOrgWithOwnerAndTarget("AGENT");

      // Simulate the token this user's already-open browser session is carrying — captured
      // at sign-in time, BEFORE the Administrator deactivates them.
      const staleToken: SessionTokenClaims = { userId: target.id, organizationId, role: "AGENT" };

      // The real production code path: an Administrator (Owner, here) deactivates the user
      // through the actual Server Action, not a raw prisma.update in this test.
      vi.mocked(auth).mockResolvedValue(fakeSession("OWNER", organization.id, owner.id));
      const deactivateResult = await deactivateUser({ userId: target.id });
      expect(deactivateResult.ok).toBe(true);

      // The stale token, refreshed now, must die instead of keeping the user signed in.
      const refreshed = await refreshSessionTokenClaims(staleToken);
      expect(refreshed).toBeNull();
    },
  );

  it(
    "a session token issued BEFORE a real updateUserRole() demotion reflects the new (lower) role on its next refresh, so requireRole enforces it",
    async () => {
      const { organization, owner, target } = await setUpOrgWithOwnerAndTarget("ADMINISTRATOR");

      // Captured at sign-in time, while the user was still an Administrator.
      const staleToken: SessionTokenClaims = { userId: target.id, organizationId, role: "ADMINISTRATOR" };
      // Before the demotion, this session's role is genuinely sufficient for an
      // Administrator-gated action.
      expect(() => requireRole(staleToken.role, "ADMINISTRATOR")).not.toThrow();

      // The real production code path: the Owner demotes the user to AGENT via the actual
      // Server Action.
      vi.mocked(auth).mockResolvedValue(fakeSession("OWNER", organization.id, owner.id));
      const demoteResult = await updateUserRole({ userId: target.id, role: "AGENT" });
      expect(demoteResult.ok).toBe(true);

      // Refreshing the STALE token (still says ADMINISTRATOR) must pick up the new role.
      const refreshed = await refreshSessionTokenClaims(staleToken);
      expect(refreshed).not.toBeNull();
      expect(refreshed?.role).toBe("AGENT");

      // And the role the refreshed token now carries is what `requireRole` actually
      // enforces — the demoted user's next Administrator-gated action attempt is rejected.
      expect(() => requireRole(refreshed?.role, "ADMINISTRATOR")).toThrow(ForbiddenError);
    },
  );

  it("invalidates a token with no userId claim (defensive: a malformed/pre-fix token)", async () => {
    const refreshed = await refreshSessionTokenClaims({});
    expect(refreshed).toBeNull();
  });

  it("invalidates a token whose user row no longer exists", async () => {
    const { organization } = await setUpOrgWithOwnerAndTarget("AGENT");
    const refreshed = await refreshSessionTokenClaims({
      userId: "nonexistent-user-id",
      organizationId: organization.id,
      role: "AGENT",
    });
    expect(refreshed).toBeNull();
  });
});
