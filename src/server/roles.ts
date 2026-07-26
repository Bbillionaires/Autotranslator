/**
 * Role ordering and guard, per docs/implementation-plan.md §6.2:
 * OWNER(4) > ADMINISTRATOR(3) > MANAGER(2) > AGENT(1) > VIEWER(0).
 *
 * `requireRole()` is the single guard Server Actions and Route Handlers should call at
 * the top of any mutation/sensitive read — enforced server-side, never just hidden in the
 * UI. Full usage across every service function lands alongside those services in later
 * phases; this establishes the guard itself plus the nav-visibility use in Phase 3.
 */
import type { Role } from "@prisma/client";
import { ForbiddenError } from "./errors";

export const ROLE_RANK: Record<Role, number> = {
  VIEWER: 0,
  AGENT: 1,
  MANAGER: 2,
  ADMINISTRATOR: 3,
  OWNER: 4,
};

export function roleAtLeast(role: Role, minRole: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[minRole];
}

/**
 * Throws ForbiddenError if `role` does not meet `minRole`. Call from Server Actions /
 * Route Handlers with the session's role, e.g.:
 *
 *   requireRole(session.user.role, "MANAGER");
 */
export function requireRole(role: Role | null | undefined, minRole: Role): void {
  if (!role || !roleAtLeast(role, minRole)) {
    throw new ForbiddenError(`This action requires the ${minRole} role or higher.`, {
      role,
      minRole,
    });
  }
}
