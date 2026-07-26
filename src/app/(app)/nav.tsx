"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut } from "next-auth/react";
import type { Role } from "@prisma/client";
import { NAV_ITEMS } from "./nav-items";
import { roleAtLeast } from "@/server/roles";

export function Nav({
  role,
  userName,
  userEmail,
}: {
  role: Role;
  userName: string | null | undefined;
  userEmail: string | null | undefined;
}) {
  const pathname = usePathname();
  const visibleItems = NAV_ITEMS.filter((item) => roleAtLeast(role, item.minRole));

  return (
    <header className="border-b border-border bg-surface">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-4 py-3">
        <div className="flex items-center gap-6">
          <span className="text-base font-semibold tracking-tight text-foreground">
            AutoTranslator
          </span>
          <nav aria-label="Main navigation" className="flex items-center gap-1">
            {visibleItems.map((item) => {
              const isActive = pathname?.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={
                    "rounded-md px-3 py-1.5 text-sm font-medium transition-colors " +
                    (isActive
                      ? "bg-accent text-accent-foreground"
                      : "text-muted hover:bg-background hover:text-foreground")
                  }
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>
        </div>

        <div className="flex items-center gap-3">
          <div className="text-right text-xs leading-tight text-muted">
            <div className="font-medium text-foreground">{userName ?? userEmail}</div>
            <div>{role}</div>
          </div>
          <button
            type="button"
            onClick={() => signOut({ callbackUrl: "/sign-in" })}
            className="rounded-md border border-border px-3 py-1.5 text-sm font-medium text-foreground hover:bg-background"
          >
            Sign out
          </button>
        </div>
      </div>
    </header>
  );
}
