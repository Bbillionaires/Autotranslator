/**
 * Tests for `userRepository.findByEmail`'s M3 fix (docs/review-report.md): previously a bare
 * `findFirst`, silently returning an arbitrary match if the same email existed in more than
 * one organization. Now: zero matches -> null, exactly one match -> that user, more than one
 * match -> throws (fail clearly instead of guessing an org).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = {
  user: {
    findMany: vi.fn(),
  },
};

vi.mock("../db", () => ({ prisma: prismaMock }));

const { userRepository } = await import("./userRepository");

const userA = { id: "u_a", organizationId: "org_a", email: "shared@test.dev", role: "AGENT" };
const userB = { id: "u_b", organizationId: "org_b", email: "shared@test.dev", role: "MANAGER" };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("userRepository.findByEmail", () => {
  it("returns null when no user matches", async () => {
    prismaMock.user.findMany.mockResolvedValue([]);
    const result = await userRepository.findByEmail("nobody@test.dev");
    expect(result).toBeNull();
  });

  it("returns the single matching user when exactly one exists", async () => {
    prismaMock.user.findMany.mockResolvedValue([userA]);
    const result = await userRepository.findByEmail("shared@test.dev");
    expect(result).toEqual(userA);
  });

  it("M3: throws when the same email matches more than one organization's User, instead of silently picking one", async () => {
    prismaMock.user.findMany.mockResolvedValue([userA, userB]);
    await expect(userRepository.findByEmail("shared@test.dev")).rejects.toThrow(/multiple accounts/i);
  });
});
