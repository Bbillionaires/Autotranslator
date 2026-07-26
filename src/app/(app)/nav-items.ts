import type { Role } from "@prisma/client";

export interface NavItem {
  href: string;
  label: string;
  /** Minimum role required to see this item in the nav. */
  minRole: Role;
}

/**
 * Nav visibility by role, per docs/implementation-plan.md §5 (route auth legend) and §6.2
 * (role ordering). This only controls what's *shown*; the actual pages/actions must also
 * enforce the same (or stricter) checks server-side — hiding a nav link is a UX nicety,
 * not a security boundary.
 */
export const NAV_ITEMS: NavItem[] = [
  { href: "/inbox", label: "Inbox", minRole: "VIEWER" },
  { href: "/contacts", label: "Contacts", minRole: "VIEWER" },
  { href: "/teams", label: "Teams", minRole: "MANAGER" },
  { href: "/settings", label: "Settings", minRole: "ADMINISTRATOR" },
];
