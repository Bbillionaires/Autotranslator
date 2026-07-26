import { redirect } from "next/navigation";
import { auth } from "@/server/auth";
import { roleAtLeast } from "@/server/roles";

export default async function SettingsPage() {
  const session = await auth();
  if (!session?.user || !roleAtLeast(session.user.role, "ADMINISTRATOR")) {
    redirect("/inbox");
  }

  return (
    <div className="flex flex-col gap-2">
      <h1 className="text-2xl font-semibold text-foreground">Settings</h1>
      <p className="max-w-2xl text-sm text-muted">
        Org settings, channel integrations, glossary management, and data retention controls are
        built in Phase 7. This page is only shown to Administrator+ roles, confirming role-gated nav
        visibility works.
      </p>
    </div>
  );
}
