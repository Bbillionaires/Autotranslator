/**
 * Tests for `verifyCredentials` (the Credentials provider's `authorize()` logic, defined in
 * `credentialsAuth.ts` — see that module's doc comment for why it's a separate module from
 * `auth.ts`: importing `auth.ts` directly would pull in the full `NextAuth(...)` call,
 * which doesn't resolve under this repo's Vitest "node" environment), per
 * docs/implementation-plan.md §5/§6.2, plus two fixes from docs/review-report.md:
 *   - H2: sign-in is now rate-limited (keyed by IP+email).
 *   - M3: a bare-email lookup that matches more than one organization's User now fails
 *     clearly instead of silently picking an arbitrary match.
 *
 * Runs against a REAL Postgres test database (see src/server/messaging/__tests__/testDb.ts)
 * since both fixes depend on genuine DB state (multiple orgs sharing an email).
 */
import bcrypt from "bcryptjs";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { configureTestDatabaseEnv } from "./messaging/__tests__/testDb";

configureTestDatabaseEnv();

const { prisma } = await import("./db");
const { organizationRepository } = await import("./repositories/organizationRepository");
const { userRepository } = await import("./repositories/userRepository");
const { AUTH_RATE_LIMIT } = await import("./rateLimit");
const { verifyCredentials } = await import("./credentialsAuth");

const DEV_PASSWORD = "correct horse battery staple";

let organizationIds: string[] = [];

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  await prisma.$disconnect();
});

afterEach(async () => {
  if (organizationIds.length > 0) {
    await prisma.organization.deleteMany({ where: { id: { in: organizationIds } } });
    organizationIds = [];
  }
});

function buildRequest(ip: string): Request {
  return new Request("https://example.com/api/auth/callback/credentials", {
    method: "POST",
    headers: { "X-Forwarded-For": ip },
  });
}

async function createOrgAndUser(email: string, password = DEV_PASSWORD) {
  const organization = await organizationRepository.create({ name: `Auth Test Org ${Date.now()}-${Math.random()}` });
  organizationIds.push(organization.id);
  const passwordHash = await bcrypt.hash(password, 10);
  const user = await userRepository.create({
    organizationId: organization.id,
    name: "Test User",
    email,
    role: "AGENT",
    passwordHash,
  });
  return { organization, user };
}

describe("verifyCredentials", () => {
  it("returns the user for correct email+password", async () => {
    const email = `agent-${Date.now()}-${Math.random()}@test.dev`;
    const { user, organization } = await createOrgAndUser(email);

    const result = await verifyCredentials({ email, password: DEV_PASSWORD }, buildRequest(`10.0.0.${Math.floor(Math.random() * 250) + 1}`));
    expect(result).not.toBeNull();
    expect(result?.id).toBe(user.id);
    expect(result?.organizationId).toBe(organization.id);
  });

  it("returns null for a wrong password", async () => {
    const email = `agent-${Date.now()}-${Math.random()}@test.dev`;
    await createOrgAndUser(email);

    const result = await verifyCredentials({ email, password: "wrong-password" }, buildRequest(`10.0.1.${Math.floor(Math.random() * 250) + 1}`));
    expect(result).toBeNull();
  });

  it("returns null for an unknown email", async () => {
    const result = await verifyCredentials(
      { email: "nobody@test.dev", password: DEV_PASSWORD },
      buildRequest(`10.0.2.${Math.floor(Math.random() * 250) + 1}`),
    );
    expect(result).toBeNull();
  });

  it("returns null for malformed input (fails Zod validation)", async () => {
    const result = await verifyCredentials({ email: "not-an-email" }, buildRequest(`10.0.3.${Math.floor(Math.random() * 250) + 1}`));
    expect(result).toBeNull();
  });

  it("H2: rate-limits sign-in attempts keyed by IP+email — the (limit+1)th attempt from the same IP+email is rejected even with the correct password", async () => {
    const email = `agent-${Date.now()}-${Math.random()}@test.dev`;
    await createOrgAndUser(email);
    const ip = `10.1.0.${Math.floor(Math.random() * 250) + 1}`;

    for (let i = 0; i < AUTH_RATE_LIMIT.limit; i++) {
      // Deliberately wrong password each time — attacker credential-stuffing shape — still
      // must be reachable up to the limit (rejected for wrong password, not rate limit).
      const result = await verifyCredentials({ email, password: "wrong" }, buildRequest(ip));
      expect(result).toBeNull();
    }

    // The next attempt, even with the CORRECT password, must be rejected by the rate
    // limiter — proving the limiter (not just the password check) is what's gating here.
    const rateLimited = await verifyCredentials({ email, password: DEV_PASSWORD }, buildRequest(ip));
    expect(rateLimited).toBeNull();
  });

  it("H2: rate limiting is scoped per IP+email — a different IP for the same email is unaffected", async () => {
    const email = `agent-${Date.now()}-${Math.random()}@test.dev`;
    await createOrgAndUser(email);
    const attackerIp = `10.1.1.${Math.floor(Math.random() * 250) + 1}`;
    const legitimateIp = `10.1.2.${Math.floor(Math.random() * 250) + 1}`;

    for (let i = 0; i < AUTH_RATE_LIMIT.limit; i++) {
      await verifyCredentials({ email, password: "wrong" }, buildRequest(attackerIp));
    }

    const fromLegitimateIp = await verifyCredentials({ email, password: DEV_PASSWORD }, buildRequest(legitimateIp));
    expect(fromLegitimateIp).not.toBeNull();
  });

  it("M3: fails clearly (returns null) rather than picking an arbitrary org when the same email exists in two organizations", async () => {
    const sharedEmail = `shared-${Date.now()}-${Math.random()}@test.dev`;
    await createOrgAndUser(sharedEmail, "password-one");
    await createOrgAndUser(sharedEmail, "password-two");

    const result = await verifyCredentials(
      { email: sharedEmail, password: "password-one" },
      buildRequest(`10.2.0.${Math.floor(Math.random() * 250) + 1}`),
    );
    expect(result).toBeNull();
  });
});
