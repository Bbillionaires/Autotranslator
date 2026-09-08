/**
 * Role ordering, per docs/implementation-plan.md §6.2: OWNER(4) > ADMINISTRATOR(3) >
 * MANAGER(2) > AGENT(1) > VIEWER(0).
 *
 * Lives under `src/lib` (not `src/server`) specifically so it stays free of any
 * server-only dependency (env, logger, db, ...) and can be imported directly by Client
 * Components like `(app)/nav.tsx` for nav-item visibility — `src/server/roles.ts`
 * re-exports these for server-side call sites and adds the server-only `requireRole` guard.
 */
import type { Role } from "@prisma/client";

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
