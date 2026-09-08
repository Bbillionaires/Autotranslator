/**
 * Server-side role guard, per docs/implementation-plan.md §6.2.
 *
 * `requireRole()` is the single guard Server Actions and Route Handlers should call at
 * the top of any mutation/sensitive read — enforced server-side, never just hidden in the
 * UI. The underlying rank table and `roleAtLeast()` live in `src/lib/roles.ts` (no
 * server-only dependencies) so Client Components can import the ordering directly for
 * nav-visibility without pulling this module's `ForbiddenError`/logger/env import chain
 * into the client bundle.
 */
import type { Role } from "@prisma/client";
import { ForbiddenError } from "./errors";

export { ROLE_RANK, roleAtLeast } from "@/lib/roles";
import { roleAtLeast } from "@/lib/roles";

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
