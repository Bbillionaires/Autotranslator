"use server";

/**
 * User-management Server Actions — H3 fix (docs/review-report.md).
 *
 * per docs/implementation-plan.md §5: "Admin | Server Action `listUsers` / `inviteUser` /
 * `updateUserRole` / `deactivateUser` | User management | Session+Role(Administrator+) |
 * role changes audit-logged; cannot self-demote last Owner." Before this fix, RBAC
 * (Owner/Administrator/Manager/Agent/Viewer) was fully enforced everywhere but there was NO
 * way to invite a user, change a role, or deactivate a user through the running app — only
 * `prisma/seed.ts` or direct DB access could ever assign a role.
 *
 * ## Invite flow — no real email sending (documented tradeoff)
 * There's no email-sending transport wired up anywhere in this MVP (Auth.js's magic-link
 * provider logs to the console instead of sending — see `auth.ts`'s `devConsoleEmailProvider`
 * doc comment). Rather than half-build a second email path just for invites, `inviteUser`
 * follows the Android gateway's "issue a one-time secret, show it in the response exactly
 * once, never again" precedent (`POST /api/gateways/register`): it creates the `User` row
 * directly with a freshly generated random temporary password (bcrypt-hashed, same as
 * `prisma/seed.ts`) and returns the plaintext temporary password to the calling
 * Administrator, who is expected to relay it to the invitee through whatever
 * out-of-band channel they'd already use (Slack, a shared doc, in person, ...). This is a
 * real, documented product gap (no "reset your password" self-service flow exists yet
 * either) — flagged here rather than silently decided, matching this codebase's convention
 * for MVP simplifications (see docs/channel-adapters.md's "Known limitations" sections).
 *
 * ## "Cannot self-demote/deactivate the last Owner"
 * `assertNotRemovingLastOwner` is the shared guard both `updateUserRole` (demoting an OWNER
 * to a lower role) and `deactivateUser` (deactivating an OWNER) call before mutating —
 * if the target user is currently the ORG's only non-deactivated OWNER, both are rejected
 * with a `ConflictError`. This is intentionally broader than literally "self"-demote (it
 * also blocks an Owner accidentally demoting/deactivating a co-Owner who happens to be the
 * last one) since the actual invariant that matters is "an organization must always retain
 * at least one Owner," not just "you can't do it to your own account."
 *
 * ## Privilege-escalation guard
 * Neither `inviteUser` nor `updateUserRole` lets an Administrator grant a role HIGHER than
 * their own (i.e. only an Owner can create/promote another Owner) — a small, natural RBAC
 * hardening consistent with `requireRole`'s existing discipline, not called out explicitly
 * in the plan's one-line spec but a reasonable reading of "Owner is the only role that can
 * ... (eventually) delete the organization" (§6.2) implying Owner-granting should be
 * Owner-only too.
 */
import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { z } from "zod";
import type { Role, User } from "@prisma/client";
import { auth } from "../auth";
import { ConflictError, ForbiddenError, toSafeActionError } from "../errors";
import { auditLogRepository } from "../repositories/auditLogRepository";
import { userRepository } from "../repositories/userRepository";
import { requireRole, ROLE_RANK } from "../roles";

type ActionResult<T> = { ok: true; data: T } | { ok: false; message: string; code: string; requestId: string };

const ROLE_ENUM = z.enum(["OWNER", "ADMINISTRATOR", "MANAGER", "AGENT", "VIEWER"]);
/** Loose BCP-47 validator — matches the one used elsewhere in src/server/actions. */
const bcp47LanguageCode = z.string().min(2, "Language code is required.").max(35, "Language code is too long.");

export interface AdminUserView {
  id: string;
  name: string;
  email: string;
  role: Role;
  preferredLanguage: string;
  deactivatedAt: string | null;
  createdAt: string;
}

function toView(user: User): AdminUserView {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    preferredLanguage: user.preferredLanguage,
    deactivatedAt: user.deactivatedAt ? user.deactivatedAt.toISOString() : null,
    createdAt: user.createdAt.toISOString(),
  };
}

/** Throws ForbiddenError if `role` outranks the acting session's own role — only an Owner can grant/hold Owner, etc. */
function assertNotGrantingAboveOwnRank(actingRole: Role, targetRole: Role): void {
  if (ROLE_RANK[targetRole] > ROLE_RANK[actingRole]) {
    throw new ForbiddenError("You cannot grant a role higher than your own.", { actingRole, targetRole });
  }
}

/**
 * Guards the "cannot self-demote/deactivate the last Owner" invariant (§5). Only relevant
 * when the TARGET user currently holds OWNER — anything else is a no-op check.
 */
async function assertNotRemovingLastOwner(organizationId: string, targetUserId: string, action: "role_change" | "deactivate", newRole?: Role): Promise<void> {
  const target = await userRepository.findByIdInOrgOrThrow(organizationId, targetUserId);
  if (target.role !== "OWNER") {
    return;
  }
  if (action === "role_change" && newRole === "OWNER") {
    return; // staying an Owner — not a removal
  }
  const ownerCount = await userRepository.countActiveOwners(organizationId);
  if (ownerCount <= 1) {
    throw new ConflictError("Cannot remove the last Owner of an organization.", { organizationId, targetUserId });
  }
}

/** Server Action `listUsers` — Session+Role(Administrator+). */
export async function listUsers(): Promise<ActionResult<AdminUserView[]>> {
  try {
    const session = await auth();
    requireRole(session?.user?.role, "ADMINISTRATOR");
    const organizationId = session!.user.organizationId;

    const users = await userRepository.listByOrg(organizationId);
    return { ok: true, data: users.map(toView) };
  } catch (error) {
    return { ok: false, ...toSafeActionError(error) };
  }
}

const inviteUserSchema = z.object({
  name: z.string().min(1, "Name is required.").max(200),
  email: z.string().email(),
  role: ROLE_ENUM,
  preferredLanguage: bcp47LanguageCode.optional(),
});
export type InviteUserInput = z.infer<typeof inviteUserSchema>;

export interface InviteUserResult {
  user: AdminUserView;
  temporaryPassword: string;
}

/** Server Action `inviteUser` — Session+Role(Administrator+), audit-logged. See module doc comment for the "no real email" tradeoff. */
export async function inviteUser(input: InviteUserInput): Promise<ActionResult<InviteUserResult>> {
  try {
    const session = await auth();
    requireRole(session?.user?.role, "ADMINISTRATOR");
    const organizationId = session!.user.organizationId;

    const parsed = inviteUserSchema.parse(input);
    assertNotGrantingAboveOwnRank(session!.user.role, parsed.role);

    const temporaryPassword = randomBytes(12).toString("base64url");
    const passwordHash = await bcrypt.hash(temporaryPassword, 10);

    let user: User;
    try {
      user = await userRepository.create({
        organizationId,
        name: parsed.name,
        email: parsed.email,
        role: parsed.role,
        preferredLanguage: parsed.preferredLanguage,
        passwordHash,
      });
    } catch {
      // @@unique([organizationId, email]) — the same email already exists in this org.
      throw new ConflictError("A user with this email already exists in this organization.", { email: parsed.email });
    }

    await auditLogRepository.record({
      organizationId,
      userId: session!.user.id,
      action: "user.invited",
      entityType: "User",
      entityId: user.id,
      metadata: { email: user.email, role: user.role },
    });

    return { ok: true, data: { user: toView(user), temporaryPassword } };
  } catch (error) {
    return { ok: false, ...toSafeActionError(error) };
  }
}

const updateUserRoleSchema = z.object({ userId: z.string().min(1), role: ROLE_ENUM });
export type UpdateUserRoleInput = z.infer<typeof updateUserRoleSchema>;

/** Server Action `updateUserRole` — Session+Role(Administrator+), audit-logged, cannot demote the last Owner. */
export async function updateUserRole(input: UpdateUserRoleInput): Promise<ActionResult<AdminUserView>> {
  try {
    const session = await auth();
    requireRole(session?.user?.role, "ADMINISTRATOR");
    const organizationId = session!.user.organizationId;

    const parsed = updateUserRoleSchema.parse(input);
    assertNotGrantingAboveOwnRank(session!.user.role, parsed.role);
    await assertNotRemovingLastOwner(organizationId, parsed.userId, "role_change", parsed.role);

    const before = await userRepository.findByIdInOrgOrThrow(organizationId, parsed.userId);
    const updated = await userRepository.updateRole(organizationId, parsed.userId, parsed.role);

    await auditLogRepository.record({
      organizationId,
      userId: session!.user.id,
      action: "user.role_changed",
      entityType: "User",
      entityId: parsed.userId,
      metadata: { fromRole: before.role, toRole: parsed.role },
    });

    return { ok: true, data: toView(updated) };
  } catch (error) {
    return { ok: false, ...toSafeActionError(error) };
  }
}

const deactivateUserSchema = z.object({ userId: z.string().min(1) });

/** Server Action `deactivateUser` — Session+Role(Administrator+), audit-logged, cannot deactivate the last Owner. */
export async function deactivateUser(input: z.infer<typeof deactivateUserSchema>): Promise<ActionResult<AdminUserView>> {
  try {
    const session = await auth();
    requireRole(session?.user?.role, "ADMINISTRATOR");
    const organizationId = session!.user.organizationId;

    const parsed = deactivateUserSchema.parse(input);
    await assertNotRemovingLastOwner(organizationId, parsed.userId, "deactivate");

    const updated = await userRepository.deactivate(organizationId, parsed.userId);

    await auditLogRepository.record({
      organizationId,
      userId: session!.user.id,
      action: "user.deactivated",
      entityType: "User",
      entityId: parsed.userId,
    });

    return { ok: true, data: toView(updated) };
  } catch (error) {
    return { ok: false, ...toSafeActionError(error) };
  }
}
